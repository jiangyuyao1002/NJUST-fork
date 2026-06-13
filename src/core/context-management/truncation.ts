import { TelemetryService } from "@njust-ai/telemetry"
import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"
import { ApiHandler } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { expandTruncationToAtomicUnits } from "./grouping"
import {
	ContextHierarchy,
	findTurnIndex,
	computeTurnSelfAttentionMean,
	computeFileHotness,
	getQueryAttention,
	tokenizeForRelevance,
	jaccardSimilarity,
} from "./contextHierarchy"

export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Fixed token buffer reserved for tool calls / response headroom.
 */
export const TOKEN_BUFFER_TOKENS = 13000

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Message weight constants for intelligent truncation.
 * Higher weight = more valuable = less likely to be truncated.
 */
const MESSAGE_WEIGHTS = {
	ERROR_RECOVERY: 10,
	RECENT_TOOL_WRITE: 8,
	CODE_MODIFICATION: 7,
	RECENT_TOOL_READ: 5,
	SEARCH_RESULT: 4,
	ASSISTANT_REASONING: 3,
	USER_MESSAGE: 3,
	OLD_TOOL_RESULT: 2,
	PURE_TEXT_DIALOG: 1,
} as const

/** Number of recent turns to protect from truncation */
const PROTECTED_RECENT_TURNS = 3

/** Half-life in visible-message steps for age decay */
const AGE_DECAY_HALFLIFE = 12

function hasCodeModification(message: ApiMessage): boolean {
	const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
	return /write_to_file|apply_diff|insert_content|search_and_replace/.test(content)
}

function isErrorRecoveryMessage(message: ApiMessage): boolean {
	const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
	return /error|retry|recovery|failed|circuit.?breaker/i.test(content)
}

function isToolResult(message: ApiMessage): boolean {
	if (!Array.isArray(message.content)) return false
	return message.content.some((block: Anthropic.Messages.ContentBlockParam): boolean => block.type === "tool_result")
}

function isToolUseWithWrite(message: ApiMessage): boolean {
	if (!Array.isArray(message.content)) return false
	return message.content.some(
		(block: Anthropic.Messages.ContentBlockParam): boolean =>
			block.type === "tool_use" &&
			/write_to_file|apply_diff|insert_content|search_and_replace/.test(
				(block as Anthropic.Messages.ToolUseBlockParam).name || "",
			),
	)
}

function getMessageBaseWeight(message: ApiMessage, isRecent: boolean): number {
	if (isErrorRecoveryMessage(message)) return MESSAGE_WEIGHTS.ERROR_RECOVERY
	if (hasCodeModification(message) || isToolUseWithWrite(message)) {
		return isRecent ? MESSAGE_WEIGHTS.RECENT_TOOL_WRITE : MESSAGE_WEIGHTS.CODE_MODIFICATION
	}
	if (isToolResult(message)) {
		return isRecent ? MESSAGE_WEIGHTS.RECENT_TOOL_READ : MESSAGE_WEIGHTS.OLD_TOOL_RESULT
	}
	if (message.role === "assistant") return MESSAGE_WEIGHTS.ASSISTANT_REASONING
	if (message.role === "user") return MESSAGE_WEIGHTS.USER_MESSAGE
	return MESSAGE_WEIGHTS.PURE_TEXT_DIALOG
}

function evaluateMessageWeight(
	message: ApiMessage,
	index: number,
	totalVisible: number,
	referenceTokens: Set<string>,
	hierarchy?: ContextHierarchy,
): number {
	const isRecent = index >= totalVisible - PROTECTED_RECENT_TURNS * 2
	const baseWeight = getMessageBaseWeight(message, isRecent)
	const ageSteps = Math.max(0, totalVisible - 1 - index)
	const ageDecay = Math.pow(0.5, ageSteps / AGE_DECAY_HALFLIFE)
	const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
	const similarity = jaccardSimilarity(tokenizeForRelevance(text), referenceTokens)
	const relevanceBoost = similarity * 3
	const recencyBoost = isRecent ? 0.5 : 0

	// ───── CSA enhancement: cross-turn attention factors ─────
	let csaBoost = 0
	if (hierarchy && hierarchy.turnCount > 0) {
		const turnIdx = findTurnIndex(hierarchy, index)
		if (turnIdx >= 0) {
			const ap = hierarchy.adaptiveParams

			// Factor 1: turn self-attention mean (centrality of this turn in the conversation)
			const selfAttnMean = computeTurnSelfAttentionMean(hierarchy, turnIdx)
			csaBoost += selfAttnMean * ap.selfAttnMeanMult

			// Factor 2: query attention (similarity of this turn to the last turn)
			const queryAttn = getQueryAttention(hierarchy, turnIdx)
			csaBoost += queryAttn * ap.queryAttnMult

			// Factor 3: file hotness (how many other turns share the same files)
			const fileHotness = computeFileHotness(hierarchy, turnIdx)
			csaBoost += fileHotness * ap.fileHotnessMult
		}
	}

	return baseWeight * ageDecay + relevanceBoost + csaBoost + recencyBoost
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * Uses intelligent weight-based truncation: messages are evaluated by importance
 * (error recovery > tool writes > code modifications > tool reads > dialog),
 * and low-priority messages are truncated first. Recent messages are protected.
 *
 * Falls back to simple proportional truncation if smart truncation cannot find
 * enough low-priority candidates.
 *
 * The first message is always retained. A truncation marker is inserted to track
 * where truncation occurred. This implements non-destructive sliding window
 * truncation, allowing messages to be restored if the user rewinds past the
 * truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation, used for telemetry
 * @param {ContextHierarchy} [hierarchy] - Optional hierarchical context for CSA-enhanced scoring
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(
	messages: ApiMessage[],
	fracToRemove: number,
	taskId: string,
	hierarchy?: ContextHierarchy,
): TruncationResult {
	TelemetryService.instance.captureSlidingWindowTruncation(taskId)
	const truncationId = crypto.randomUUID()

	// Filter to only visible messages (those not already truncated)
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove + (rawMessagesToRemove % 2) // Round up to even for user/assistant pairs

	if (rawMessagesToRemove <= 0) {
		return { messages, truncationId, messagesRemoved: 0 }
	}

	// === SMART TRUNCATION: dynamic weight-based selection ===
	const lastVisibleMessage = messages[visibleIndices[visibleIndices.length - 1]!]
	const referenceText =
		typeof lastVisibleMessage?.content === "string"
			? lastVisibleMessage.content
			: JSON.stringify(lastVisibleMessage?.content ?? "")
	const referenceTokens = tokenizeForRelevance(referenceText)

	const candidateWeights: Array<{ visibleIdx: number; originalIdx: number; weight: number }> = []
	for (let i = 1; i < visibleIndices.length; i++) {
		const originalIdx = visibleIndices[i]!
		const weight = evaluateMessageWeight(messages[originalIdx]!, i, visibleCount, referenceTokens, hierarchy)
		candidateWeights.push({ visibleIdx: i, originalIdx, weight })
	}

	// Protect last PROTECTED_RECENT_TURNS * 2 messages
	const protectedStart = visibleCount - PROTECTED_RECENT_TURNS * 2

	// Sort candidates by weight ascending (lowest weight first = truncated first).
	// HCA enhancement: when hierarchy is available, prefer truncating from
	// low-importance turns first to preserve high-importance turn integrity.
	candidateWeights.sort((a, b) => {
		if (hierarchy) {
			const turnA = findTurnIndex(hierarchy, a.originalIdx)
			const turnB = findTurnIndex(hierarchy, b.originalIdx)
			if (turnA >= 0 && turnB >= 0 && turnA !== turnB) {
				const impA = computeTurnSelfAttentionMean(hierarchy, turnA)
				const impB = computeTurnSelfAttentionMean(hierarchy, turnB)
				if (impA !== impB) return impA - impB // low-importance turn = truncated first
			}
		}
		// Same turn (or no hierarchy): sort by weight, ties broken by age
		if (a.weight !== b.weight) return a.weight - b.weight
		return a.visibleIdx - b.visibleIdx
	})

	// Select messages to truncate: pick lowest-weight messages, skip protected
	const indicesToTruncate = new Set<number>()
	let removed = 0
	for (const candidate of candidateWeights) {
		if (removed >= messagesToRemove) break
		// Skip protected recent messages
		if (candidate.visibleIdx >= protectedStart) continue
		// Explicitly protect error recovery messages — do not rely on
		// weight alone since CSA boosts can inflate non-error weights.
		if (isErrorRecoveryMessage(messages[candidate.originalIdx]!)) continue

		indicesToTruncate.add(candidate.originalIdx)
		removed++
	}

	// Expand to include paired tool_use/tool_result messages within the
	// same API-round boundary, preventing orphan tool_use or tool_result
	// blocks that would cause API errors.
	if (removed > 0) {
		const expanded = expandTruncationToAtomicUnits(messages, indicesToTruncate)
		removed = expanded.size
		for (const idx of expanded) {
			indicesToTruncate.add(idx)
		}
	}

	// Fallback: if smart truncation couldn't find enough candidates, use original proportional approach
	if (removed === 0) {
		const fallbackIndicesToTruncate = new Set(visibleIndices.slice(1, messagesToRemove + 1))
		const fallbackTaggedMessages = messages.map((msg, index) => {
			if (fallbackIndicesToTruncate.has(index)) {
				return { ...msg, truncationParent: truncationId }
			}
			return msg
		})

		const fallbackFirstKeptVisibleIndex = visibleIndices[messagesToRemove + 1] ?? fallbackTaggedMessages.length
		const fallbackFirstKeptTs = messages[fallbackFirstKeptVisibleIndex]?.ts ?? Date.now()
		const fallbackMarker: ApiMessage = {
			role: "user",
			content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
			ts: fallbackFirstKeptTs - 1,
			isTruncationMarker: true,
			truncationId,
		}

		const fallbackResult = [
			...fallbackTaggedMessages.slice(0, fallbackFirstKeptVisibleIndex),
			fallbackMarker,
			...fallbackTaggedMessages.slice(fallbackFirstKeptVisibleIndex),
		]

		return { messages: fallbackResult, truncationId, messagesRemoved: messagesToRemove }
	}

	// Tag selected messages as truncated
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Insert truncation marker: find the first non-truncated visible message after truncated ones
	let firstKeptVisibleIndex = taggedMessages.length
	for (const idx of visibleIndices) {
		if (!indicesToTruncate.has(idx) && idx !== visibleIndices[0]) {
			firstKeptVisibleIndex = idx
			break
		}
	}

	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Intelligent truncation: ${removed} low-priority messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return { messages: result, truncationId, messagesRemoved: removed }
}
