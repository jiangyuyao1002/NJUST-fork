import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@njust-ai-cj/telemetry"
import { logger } from "../../shared/logger"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@njust-ai-cj/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { preprocessMessages } from "./preprocess"
import { postCompactRestore } from "./postCompactRestore"
import { shouldSkipCompactForCache, getAdjustedCompactThreshold } from "../condense/cacheAwareCompact"
import { loadSessionMemories, formatSessionMemoriesForPrompt } from "../condense/sessionMemoryCompact"
import { globalCacheMetrics } from "../../utils/cacheMetrics"
import { expandTruncationToAtomicUnits, hasToolResults } from "./grouping"
import { analyzeContextTokens } from "./contextAnalysis"
import { generateSuggestions, formatSuggestions } from "./contextSuggestions"
import { globalHookRegistry } from "../hooks"
import {
	ContextHierarchy,
	buildContextHierarchy,
	findTurnIndex,
	computeTurnSelfAttentionMean,
	computeFileHotness,
	getQueryAttention,
	tokenizeForRelevance,
	jaccardSimilarity,
} from "./contextHierarchy"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Legacy percentage buffer kept for backward compatibility in tests/imports.
 * Dynamic thresholding now primarily uses TOKEN_BUFFER_TOKENS.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Fixed token buffer reserved for tool calls / response headroom.
 */
export const TOKEN_BUFFER_TOKENS = 13000

/**
 * Auto-compact circuit breaker: maximum consecutive condensation failures
 * before falling back to forced truncation.
 *
 * Inspired by Claude Code's autoCompact.ts which discovered that 1,279 sessions
 * experienced 50+ consecutive failures, wasting ~250K API calls daily.
 * The circuit breaker prevents this by cutting off after a small number of failures.
 */
export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3


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
			/write_to_file|apply_diff|insert_content|search_and_replace/.test((block as Anthropic.Messages.ToolUseBlockParam).name || ""),
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
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string, hierarchy?: ContextHierarchy): TruncationResult {
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
	const lastVisibleMessage = messages[visibleIndices[visibleIndices.length - 1]]
	const referenceText =
		typeof lastVisibleMessage?.content === "string"
			? lastVisibleMessage.content
			: JSON.stringify(lastVisibleMessage?.content ?? "")
	const referenceTokens = tokenizeForRelevance(referenceText)

	const candidateWeights: Array<{ visibleIdx: number; originalIdx: number; weight: number }> = []
	for (let i = 1; i < visibleIndices.length; i++) {
		const originalIdx = visibleIndices[i]
		const weight = evaluateMessageWeight(messages[originalIdx], i, visibleCount, referenceTokens, hierarchy)
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
		if (isErrorRecoveryMessage(messages[candidate.originalIdx])) continue

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

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = Math.max(0, contextWindow - reservedTokens - TOKEN_BUFFER_TOKENS)
		return prevContextTokens > allowedTokens
	}

	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = Math.max(0, contextWindow - reservedTokens - TOKEN_BUFFER_TOKENS)

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = contextWindow > 0 ? Math.round((100 * prevContextTokens) / contextWindow) : 0
	// Start condense slightly before the exact profile threshold to reduce “one more turn then hit limit” surprises.
	const nearCondenseThreshold =
		autoCondenseContext &&
		contextWindow > 0 &&
		contextPercent >= effectiveThreshold - 1.5 &&
		contextPercent < effectiveThreshold

	return (
		contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens || Boolean(nearCondenseThreshold)
	)
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Roo during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
	/** Optional: tokens served from provider prompt cache (for cache-aware compression) */
	cacheReadTokens?: number
	/** Optional: total tokens for computing cache ratio denominator in cache-aware logic */
	cacheAwareTotalTokens?: number
	/** Optional: enable micro compact preprocessing before condense/truncate logic */
	enableMicroCompact?: boolean
	/** Per-task count of consecutive compact failures (for circuit breaker isolation between tasks) */
	compactFailures?: number
	/** When true, skips LLM-based condensation and session-memory compaction.
	 * Used for sub-agents with small context budgets where LLM compression
	 * would waste API calls and risk recursion deadlocks. */
	isSubAgent?: boolean
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
	/** Updated compact failure count — caller should pass this back on the next invocation */
	compactFailures?: number
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
/**
 * Structured telemetry log for compaction events. Mirrors Claude Code Core's
 * tengu_compact / tengu_compact_failed events for observability.
 */
function logCompactEvent(event: string, data: Record<string, unknown>): void {
	const payload = JSON.stringify({
		event,
		timestamp: Date.now(),
		...data,
	})
	logger.info("CompactTelemetry", `${payload}`)
}

export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
	cacheReadTokens,
	cacheAwareTotalTokens,
	enableMicroCompact = true,
	compactFailures: compactFailuresIn = 0,
	isSubAgent = false,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	let compactFailures = compactFailuresIn
	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const contextPercent = contextWindow > 0 ? (100 * totalTokens) / contextWindow : 0
	// Collect assistant message timestamps for time-based microcompact trigger
	const assistantTimestamps = messages
		.filter((m) => m.role === "assistant")
		.map((m) => (typeof m.ts === "number" ? new Date(m.ts).toISOString() : String(m.ts ?? "")))
	const preprocessed = preprocessMessages(messages, { contextPercent, enableMicroCompact, assistantTimestamps })
	const preprocessedMessages = preprocessed.messages

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = preprocessedMessages[preprocessedMessages.length - 1]
	const lastMessageContent = lastMessage.content
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = Math.max(0, contextWindow - reservedTokens - TOKEN_BUFFER_TOKENS)

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			// Special case: -1 means inherit from global setting
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			// Valid custom threshold
			effectiveThreshold = profileThreshold
		} else {
			// Invalid threshold value, fall back to global setting
			logger.warn("ContextManagement", 
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	// Run context analysis for observability before compaction decisions
	(function() {
		const analysisResult = analyzeContextTokens(preprocessedMessages, 0)
		const suggestions = generateSuggestions(
			analysisResult.breakdown,
			analysisResult.duplicateReads,
			analysisResult.estimatedDuplicateReadTokens,
			analysisResult.largeToolResults,
			analysisResult.summaryMessageCount,
		)
		logCompactEvent("context_analysis", {
			toolResultPct: Math.round((analysisResult.breakdown.toolResultTokens / Math.max(1, analysisResult.breakdown.totalTokens)) * 100),
			summaryPct: Math.round((analysisResult.breakdown.summaryTokens / Math.max(1, analysisResult.breakdown.totalTokens)) * 100),
			totalTokens: analysisResult.breakdown.totalTokens,
			summaryCount: analysisResult.summaryMessageCount,
			duplicateReads: analysisResult.duplicateReads.length,
			duplicateReadTokens: analysisResult.estimatedDuplicateReadTokens,
			largeResults: analysisResult.largeToolResults.length,
			messageCount: analysisResult.totalMessageCount,
			suggestions: formatSuggestions(suggestions),
		})
	})()

	if (autoCondenseContext) {
		// Sub-agent guard: skip LLM condensation and session memory compaction.
		// Sub-agents have small context budgets (32K-64K) and LLM compression
		// would waste API calls and risk recursion deadlocks.
		if (isSubAgent) {
			if (prevContextTokens > allowedTokens) {
				logCompactEvent("compact_subagent_truncation", { prevContextTokens, allowedTokens })
				const hierarchy = buildContextHierarchy(preprocessedMessages, taskId)
				const truncationResult = truncateConversation(preprocessedMessages, 0.5, taskId, hierarchy ?? undefined)
				return {
					messages: truncationResult.messages,
					prevContextTokens,
					summary: "",
					cost: 0,
					truncationId: truncationResult.truncationId,
					messagesRemoved: truncationResult.messagesRemoved,
					compactFailures,
				}
			}
			return { messages: preprocessedMessages, prevContextTokens, summary: "", cost: 0, compactFailures }
		}

		const contextPercent = contextWindow > 0 ? Math.round((100 * prevContextTokens) / contextWindow) : 0

		// Cache-aware threshold adjustment: if prompt cache is being utilized well,
		// raise the threshold to avoid breaking the cache prematurely.
		// Use per-request cacheReadTokens when available, otherwise fall back to
		// the rolling average from globalCacheMetrics to still benefit from
		// cache awareness when providers don't report per-call breakdowns.
		const cacheAwareTokensBase = cacheAwareTotalTokens ?? totalTokens
		let effectiveCacheReadTokens = cacheReadTokens
		if (effectiveCacheReadTokens === undefined && cacheAwareTokensBase > 0) {
			const rollingHitRate = globalCacheMetrics.getRecentHitRate(10)
			if (rollingHitRate > 0) {
				effectiveCacheReadTokens = Math.round(rollingHitRate * cacheAwareTokensBase)
			}
		}
		const adjustedThreshold = effectiveCacheReadTokens !== undefined
			? getAdjustedCompactThreshold(effectiveThreshold, effectiveCacheReadTokens, cacheAwareTokensBase)
			: effectiveThreshold

		if (contextPercent >= adjustedThreshold || prevContextTokens > allowedTokens) {
				logCompactEvent("compact_triggered", {
					contextPercent,
					prevContextTokens,
					allowedTokens,
					threshold: adjustedThreshold,
				})

				// Execute pre-compact hooks (may abort via { abort: true })
				const preHookResult = await globalHookRegistry.execute({
					hookType: "preCompact",
					timestamp: Date.now(),
					taskId,
					messageCount: preprocessedMessages.length,
					tokenCount: prevContextTokens,
				})
				if (preHookResult.abort) {
					logger.warn("ContextManagement", 
						"[Context Management] Pre-compact hook aborted compaction: " +
						(preHookResult.message || "unknown reason"),
					)
					logCompactEvent("compact_aborted_hook", { reason: preHookResult.message })
					// Return immediately — the hook explicitly opted out of compaction
					// this turn. Skip truncation fallback as well.
					return {
						messages: preprocessedMessages,
						prevContextTokens,
						summary: "",
						cost: 0,
						compactFailures,
					}
				} else {
				// Cache-aware check: skip compression if prompt cache hit rate is very high
			if (effectiveCacheReadTokens !== undefined && shouldSkipCompactForCache(effectiveCacheReadTokens, cacheAwareTokensBase)) {
			logger.info("ContextManagement",
				`Skipping auto-compact: high prompt cache hit rate ` +
				`(${((effectiveCacheReadTokens / Math.max(1, cacheAwareTokensBase)) * 100).toFixed(1)}%). ` +
				`Compression would break cache and increase costs.`,
			)
				// Preserve cache by skipping condensation, but do not bypass hard context-window safety.
				// If already over budget, fall through to truncation logic below.
				if (prevContextTokens <= allowedTokens) {
					return { messages: preprocessedMessages, prevContextTokens, summary: "", cost: 0, compactFailures }
				}
			}
			// Circuit breaker: if condensation has failed too many times consecutively,
			// skip it and fall through to truncation to avoid wasting API calls
			else if (compactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
				logger.warn("ContextManagement", 
					`[Context Management] Circuit breaker triggered: ` +
					`${compactFailures} consecutive condensation failures. ` +
					`Falling back to forced truncation.`,
				)
				// Force aggressive truncation (50% removal) with hierarchy-enhanced scoring
				const hierarchy = buildContextHierarchy(preprocessedMessages, taskId)
				const truncationResult = truncateConversation(preprocessedMessages, 0.5, taskId, hierarchy ?? undefined)
				logCompactEvent("compact_truncation", {
						messagesRemoved: truncationResult.messagesRemoved,
						hierarchyEnabled: !!hierarchy,
						turnCount: hierarchy?.turnCount ?? 0,
						fileCount: hierarchy ? hierarchy.files.size : 0,
						adaptiveSelfAttnMult: hierarchy?.adaptiveParams.selfAttnMeanMult,
						adaptiveQueryAttnMult: hierarchy?.adaptiveParams.queryAttnMult,
						adaptiveFileHotnessMult: hierarchy?.adaptiveParams.fileHotnessMult,
						adaptiveAttnWeights: hierarchy
							? `${hierarchy.adaptiveParams.attnContentWeight.toFixed(2)}/${hierarchy.adaptiveParams.attnFileWeight.toFixed(2)}/${hierarchy.adaptiveParams.attnToolWeight.toFixed(2)}/${hierarchy.adaptiveParams.attnTemporalWeight.toFixed(2)}`
							: undefined,
					})
				return {
					messages: truncationResult.messages,
					prevContextTokens,
					summary: "",
					cost: 0,
					error: "Circuit breaker: forced truncation after repeated condensation failures",
					truncationId: truncationResult.truncationId,
					messagesRemoved: truncationResult.messagesRemoved,
					compactFailures,
				}
			} else {
				// Build hierarchy to keep adaptive EMA params up-to-date, even when condense succeeds
				buildContextHierarchy(preprocessedMessages, taskId)

				// Try session memory compaction first — avoids an expensive LLM API
				// call when structured conversation metadata is sufficient.
				const smResult = tryBuildLightweightSummary(
					preprocessedMessages,
					taskId,
					allowedTokens,
				)
				if (smResult) {
					logCompactEvent("compact_sm_success", { method: "lightweight_summary" })
					// Post-compact hooks (fire-and-forget)
					globalHookRegistry.execute({
						hookType: "postCompact",
						timestamp: Date.now(),
						taskId,
						messageCountBefore: preprocessedMessages.length,
						messageCountAfter: smResult.messages.length,
						tokenCountBefore: prevContextTokens,
						tokenCountAfter: 0, // SM-compact has no API call
					}).catch((err: unknown) => { logger.warn("ContextManagement", "Failed to capture compact telemetry", err) })
					compactFailures = 0
					const restored = postCompactRestore(smResult.messages, {
						recentFiles: filesReadByRoo?.slice(-5),
					})
					return {
						messages: restored,
						prevContextTokens,
						summary: smResult.summary,
						cost: 0,
						compactFailures,
					}
				}

				// Try persisted cross-session memories as zero-cost summary
				const smMemoryResult = await trySessionMemoryCompaction(
					preprocessedMessages,
					cwd,
					allowedTokens,
				)
				if (smMemoryResult) {
					logCompactEvent("compact_sm_success", { method: "session_memory" })
					// Post-compact hooks (fire-and-forget)
					globalHookRegistry.execute({
						hookType: "postCompact",
						timestamp: Date.now(),
						taskId,
						messageCountBefore: preprocessedMessages.length,
						messageCountAfter: smMemoryResult.messages.length,
						tokenCountBefore: prevContextTokens,
						tokenCountAfter: 0,
					}).catch((err: unknown) => { logger.warn("ContextManagement", "Failed to capture memory compact telemetry", err) })
					compactFailures = 0
					const restored = postCompactRestore(smMemoryResult.messages, {
						recentFiles: filesReadByRoo?.slice(-5),
					})
					return {
						messages: restored,
						prevContextTokens,
						summary: smMemoryResult.summary,
						cost: 0,
						compactFailures,
					}
				}

				// Attempt to intelligently condense the context via LLM
				const result = await summarizeConversation({
					messages: preprocessedMessages,
					apiHandler,
					systemPrompt,
					taskId,
					isAutomaticTrigger: true,
					customCondensingPrompt,
					metadata,
					environmentDetails,
					filesReadByRoo,
					cwd,
					rooIgnoreController,
				})
				if (result.error) {
					// Condensation failed - increment circuit breaker counter
					compactFailures++
					logger.warn("ContextManagement", 
						`[Context Management] Condensation failed (attempt ${compactFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${result.error}`,
					)
					error = result.error
					errorDetails = result.errorDetails
					cost = result.cost
				} else {
					// Success - reset circuit breaker counter
					logCompactEvent("compact_llm_success", { method: "llm_condensation" })
					// Post-compact hooks (fire-and-forget)
					globalHookRegistry.execute({
						hookType: "postCompact",
						timestamp: Date.now(),
						taskId,
						messageCountBefore: preprocessedMessages.length,
						messageCountAfter: result.messages.length,
						tokenCountBefore: prevContextTokens,
						tokenCountAfter: result.newContextTokens ?? prevContextTokens,
					}).catch((err: unknown) => { logger.warn("ContextManagement", "Failed to capture compact telemetry", err) })
					compactFailures = 0
					const restored = postCompactRestore(result.messages, {
						recentFiles: filesReadByRoo?.slice(-5),
						activeSkills: undefined,
						mcpDelta: undefined,
					})
					return { ...result, messages: restored, prevContextTokens, compactFailures }
				}
			}
		}
	}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		const hierarchy = buildContextHierarchy(preprocessedMessages, taskId)
		const truncationResult = truncateConversation(preprocessedMessages, 0.5, taskId, hierarchy ?? undefined)

		// Calculate new context tokens after truncation by counting non-truncated messages
		// Messages with truncationParent are hidden, so we count only those without it
		const effectiveMessages = truncationResult.messages.filter(
			(msg) => !msg.truncationParent && !msg.isTruncationMarker,
		)

		// Include system prompt tokens so this value matches what we send to the API.
		// Note: `prevContextTokens` is computed locally here (totalTokens + lastMessageTokens).
		let newContextTokensAfterTruncation = await estimateTokenCount(
			[{ type: "text", text: systemPrompt }],
			apiHandler,
		)

	const tokenEstimates = await Promise.all(
		effectiveMessages.map(async (msg) => {
		const content = msg.content
		if (Array.isArray(content)) {
			return estimateTokenCount(content, apiHandler)
		} else if (typeof content === "string") {
			return estimateTokenCount(
			[{ type: "text", text: content }],
			apiHandler,
			)
		}
		return 0
		}),
		)
		for (const estimate of tokenEstimates) {
			newContextTokensAfterTruncation += estimate
		}

		return {
			messages: truncationResult.messages,
			prevContextTokens,
			summary: "",
			cost,
			error,
			errorDetails,
			truncationId: truncationResult.truncationId,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
			compactFailures,
		}
	}
	// No truncation or condensation needed
	return { messages: preprocessedMessages, summary: "", cost, prevContextTokens, error, errorDetails , compactFailures }
}

/**
 * Build a lightweight text summary from message metadata without an LLM API call.
 *
 * Scans messages for: user prompts, assistant text content, file modifications,
 * and tool usage patterns. Constructs a structured summary that preserves
 * essential context while avoiding the cost of an LLM condensation API call.
 *
 * Returns null if the resulting context would exceed the token budget.
 */
function tryBuildLightweightSummary(
	messages: ApiMessage[],
	taskId: string,
	allowedTokens: number,
): { messages: ApiMessage[]; summary: string } | null {
	// Need at least a few messages to summarize
	if (messages.length < 4) return null

	// Extract structured information from messages
	const userMessages: string[] = []
	const fileOps: string[] = []
	const toolNames = new Set<string>()
	let lastAssistantText = ""

	for (const msg of messages) {
		if (msg.isSummary || msg.isTruncationMarker) continue
		if (msg.condenseParent || msg.truncationParent) continue

		const content = typeof msg.content === "string" ? msg.content : ""
		if (msg.role === "user" && content.length > 0 && !hasToolResults(msg)) {
			// Truncate very long user messages for the summary
			const truncated = content.length > 1000 ? content.slice(0, 1000) + "..." : content
			userMessages.push(truncated)
		}
		if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						toolNames.add(block.name)
						if (
							["write_to_file", "apply_diff", "insert_content", "search_and_replace"].includes(
								block.name,
							)
						) {
							const input = (block as Anthropic.Messages.ToolUseBlockParam).input as Record<string, unknown> | undefined
							if (typeof input?.filePath === "string") fileOps.push(input.filePath)
							else if (typeof input?.path === "string") fileOps.push(input.path)
						}
					}
					if (block.type === "text") {
						lastAssistantText = (block as Anthropic.Messages.TextBlockParam).text || ""
					}
				}
			}
		}
	}

	if (userMessages.length === 0 && fileOps.length === 0) return null

	// Build structured summary
	const sections: string[] = ["## Conversation Summary (auto-extracted)"]

	if (userMessages.length > 0) {
		sections.push(
			`### User Messages\n${userMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`,
		)
	}

	if (fileOps.length > 0) {
		const uniqueFiles = [...new Set(fileOps)].slice(0, 10)
		sections.push(`### Files Modified\n${uniqueFiles.map((f) => `- ${f}`).join("\n")}`)
	}

	if (toolNames.size > 0) {
		sections.push(`### Tools Used\n${[...toolNames].slice(0, 10).join(", ")}`)
	}

	if (lastAssistantText.length > 0) {
		const truncated = lastAssistantText.length > 2000 ? lastAssistantText.slice(0, 2000) + "..." : lastAssistantText
		sections.push(`### Last Assistant Context\n${truncated}`)
	}

	const summaryText = sections.join("\n\n")

	// Rough token estimate: if the summary + remaining messages would exceed
	// the allowed token budget, return null to fall through to LLM condensation
	// (which produces a denser summary)
	const estimatedSummaryTokens = summaryText.length / 4
	if (estimatedSummaryTokens > allowedTokens * 0.3) {
		// Summary alone would consume >30% of allowed budget — too verbose,
		// let LLM condensation produce a more concise version
		return null
	}

	// Build summary message and tag old messages
	const condenseId = crypto.randomUUID()
	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryText,
		ts: Date.now(),
		isSummary: true,
		condenseId,
		compactMetadata: {
			trigger: "auto",
			source: "lightweight",
			preCompactTokenCount: messages.length,
			messagesSummarized: messages.filter((m) => !m.isSummary && !m.condenseParent).length,
			timestamp: Date.now(),
		},
	}

	const newMessages = messages.map((msg) => {
		if (!msg.condenseParent && !msg.isSummary) {
			return { ...msg, condenseParent: condenseId }
		}
		return msg
	})
	newMessages.push(summaryMessage)

	return { messages: newMessages, summary: summaryText }
}

/**
 * Try to use persisted cross-session memories as a zero-cost compact summary.
 *
 * Loads session memories saved by persistSessionMemory() from previous sessions
 * and formats them as a structured summary, avoiding an expensive LLM API call.
 *
 * Returns null if no session memories are available or the budget is exceeded.
 */
async function trySessionMemoryCompaction(
	messages: ApiMessage[],
	workspaceDir: string | undefined,
	allowedTokens: number,
): Promise<{ messages: ApiMessage[]; summary: string } | null> {
	if (!workspaceDir) return null

	// Need at least a few messages to compact
	if (messages.length < 4) return null

	const memories = await loadSessionMemories(workspaceDir)
	if (memories.length === 0) return null

	// Budget: use up to 30% of allowed tokens (same ratio as tryBuildLightweightSummary)
	const budget = Math.floor(allowedTokens * 0.3)
	const summaryText = formatSessionMemoriesForPrompt(memories, budget)
	if (!summaryText) return null

	// Rough token estimate -- skip if too verbose
	const estimatedSummaryTokens = summaryText.length / 4
	if (estimatedSummaryTokens > allowedTokens * 0.3) return null

	const condenseId = crypto.randomUUID()
	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryText,
		ts: Date.now(),
		isSummary: true,
		condenseId,
		compactMetadata: {
			trigger: "auto",
			source: "session_memory",
			preCompactTokenCount: messages.length,
			messagesSummarized: messages.filter((m) => !m.isSummary && !m.condenseParent).length,
			timestamp: Date.now(),
		},
	}

	const newMessages = messages.map((msg) => {
		if (!msg.condenseParent && !msg.isSummary) {
			return { ...msg, condenseParent: condenseId }
		}
		return msg
	})
	newMessages.push(summaryMessage)

	return { messages: newMessages, summary: summaryText }
}
