import Anthropic from "@anthropic-ai/sdk"
import crypto from "crypto"

import { TelemetryService } from "@njust-ai-cj/telemetry"

import { t } from "../../i18n"
import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { ApiMessage } from "../task-persistence/apiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { findLast } from "../../shared/array"
import { logger } from "../../shared/logger"
import { supportPrompt } from "../../shared/support-prompt"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { generateFoldedFileContext } from "./foldedFileContext"
import { getCompactPrompt, getPartialCompactPrompt, formatCompactSummary } from "./prompt"
import type { PartialCompactDirection } from "./prompt"
import { getErrorMessage } from "../../shared/error-utils"

export type { FoldedFileContextResult, FoldedFileContextOptions } from "./foldedFileContext"

/**
 * Converts a tool_use block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolUseToText(block: Anthropic.Messages.ToolUseBlockParam): string {
	let input: string
	if (typeof block.input === "object" && block.input !== null) {
		input = Object.entries(block.input)
			.map(([key, value]) => {
				const formattedValue =
					typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)
				return `${key}: ${formattedValue}`
			})
			.join("\n")
	} else {
		input = String(block.input)
	}
	return `[Tool Use: ${block.name}]\n${input}`
}

/**
 * Converts a tool_result block to a text representation.
 * This allows the conversation to be summarized without requiring the tools parameter.
 */
export function toolResultToText(block: Anthropic.Messages.ToolResultBlockParam): string {
	const errorSuffix = block.is_error ? " (Error)" : ""
	if (typeof block.content === "string") {
		return `[Tool Result${errorSuffix}]\n${block.content}`
	} else if (Array.isArray(block.content)) {
		const contentText = block.content
			.map((contentBlock) => {
				if (contentBlock.type === "text") {
					return contentBlock.text
				}
				if (contentBlock.type === "image") {
					return "[Image]"
				}
				// Handle any other content block types
				return `[${(contentBlock as { type: string }).type}]`
			})
			.join("\n")
		return `[Tool Result${errorSuffix}]\n${contentText}`
	}
	return `[Tool Result${errorSuffix}]`
}

/**
 * Converts all tool_use and tool_result blocks in a message's content to text representations.
 * This is necessary for providers like Bedrock that require the tools parameter when tool blocks are present.
 * By converting to text, we can send the conversation for summarization without the tools parameter.
 *
 * @param content - The message content (string or array of content blocks)
 * @returns The transformed content with tool blocks converted to text blocks
 */
export function convertToolBlocksToText(
	content: string | Anthropic.Messages.ContentBlockParam[],
): string | Anthropic.Messages.ContentBlockParam[] {
	if (typeof content === "string") {
		return content
	}

	return content.map((block) => {
		if (block.type === "tool_use") {
			return {
				type: "text" as const,
				text: toolUseToText(block),
			}
		}
		if (block.type === "tool_result") {
			return {
				type: "text" as const,
				text: toolResultToText(block),
			}
		}
		return block
	})
}

/**
 * Transforms all messages by converting tool_use and tool_result blocks to text representations.
 * This ensures the conversation can be sent for summarization without requiring the tools parameter.
 *
 * @param messages - The messages to transform
 * @returns The transformed messages with tool blocks converted to text
 */
export function transformMessagesForCondensing<
	T extends { role: string; content: string | Anthropic.Messages.ContentBlockParam[] },
>(messages: T[]): T[] {
	return messages.map((msg) => ({
		...msg,
		content: convertToolBlocksToText(msg.content),
	}))
}

export const MIN_CONDENSE_THRESHOLD = 5 // Minimum percentage of context window to trigger condensing
export const MAX_CONDENSE_THRESHOLD = 100 // Maximum percentage of context window to trigger condensing

/**
 * System prompt for the summarization model.
 * Built via getCompactPrompt() to include the structured 9-section template,
 * <analysis> scratchpad, and aggressive no-tools enforcement.
 */
function getSummaryPrompt(): string {
	return getCompactPrompt()
}

/**
 * Injects synthetic tool_results for orphan tool_calls that don't have matching results.
 * This is necessary because OpenAI's Responses API rejects conversations with orphan tool_calls.
 * This can happen when the user triggers condense after receiving a tool_call (like attempt_completion)
 * but before responding to it.
 *
 * @param messages - The conversation messages to process
 * @returns The messages with synthetic tool_results appended if needed
 */
export function injectSyntheticToolResults(messages: ApiMessage[]): ApiMessage[] {
	// Find all tool_call IDs in assistant messages
	const toolCallIds = new Set<string>()
	// Find all tool_result IDs in user messages
	const toolResultIds = new Set<string>()

	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolCallIds.add(block.id)
				}
			}
		}
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result") {
					toolResultIds.add(block.tool_use_id)
				}
			}
		}
	}

	// Find orphans (tool_calls without matching tool_results)
	const orphanIds = [...toolCallIds].filter((id) => !toolResultIds.has(id))

	if (orphanIds.length === 0) {
		return messages
	}

	// Inject synthetic tool_results as a new user message
	const syntheticResults: Anthropic.Messages.ToolResultBlockParam[] = orphanIds.map((id) => ({
		type: "tool_result" as const,
		tool_use_id: id,
		content: "Context condensation triggered. Tool execution deferred.",
	}))

	// Timestamp is one tick after the last input message so the synthetic
	// message sits between the original conversation and the summary message.
	const lastInputTs =
		messages.length > 0 ? (messages[messages.length - 1].ts ?? Date.now()) : Date.now()
	const syntheticMessage: ApiMessage = {
		role: "user",
		content: syntheticResults,
		ts: lastInputTs + 1,
	}

	return [...messages, syntheticMessage]
}

/**
 * Extracts <command> blocks from a message's content.
 * These blocks represent active workflows that must be preserved across condensings.
 *
 * @param message - The message to extract command blocks from
 * @returns A string containing all command blocks found, or empty string if none
 */
export function extractCommandBlocks(message: ApiMessage): string {
	const content = message.content
	let text: string

	if (typeof content === "string") {
		text = content
	} else if (Array.isArray(content)) {
		// Concatenate all text blocks
		text = content
			.filter((block): block is Anthropic.Messages.TextBlockParam => block.type === "text")
			.map((block) => block.text)
			.join("\n")
	} else {
		return ""
	}

	// Match all <command> blocks including their content
	const commandRegex = /<command[^>]*>[\s\S]*?<\/command>/g
	const matches = text.match(commandRegex)

	if (!matches || matches.length === 0) {
		return ""
	}

	return matches.join("\n")
}

export type SummarizeResponse = {
	messages: ApiMessage[] // The messages after summarization
	summary: string // The summary text; empty string for no summary
	cost: number // The cost of the summarization operation
	newContextTokens?: number // The number of tokens in the context for the next API request
	error?: string // Populated iff the operation fails: error message shown to the user on failure (see Task.ts)
	errorDetails?: string // Detailed error information including stack trace and API error info
	condenseId?: string // The unique ID of the created Summary message, for linking to condense_context clineMessage
}

export type SummarizeConversationOptions = {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	isAutomaticTrigger?: boolean
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
}

/**
 * Summarizes the conversation messages using an LLM call.
 *
 * This implements the "fresh start" model where:
 * - The summary becomes a user message (not assistant)
 * - Post-condense, the model sees only the summary (true fresh start)
 * - All messages are still stored but tagged with condenseParent
 * - <command> blocks from the original task are preserved across condensings
 * - File context (folded code definitions) can be preserved for continuity
 *
 * Environment details handling:
 * - For AUTOMATIC condensing (isAutomaticTrigger=true): Environment details are included
 *   in the summary because the API request is already in progress and the next user
 *   message won't have fresh environment details injected.
 * - For MANUAL condensing (isAutomaticTrigger=false): Environment details are NOT included
 *   because fresh environment details will be injected on the very next turn via
 *   getEnvironmentDetails() in recursivelyMakeClineRequests().
 */
/**
 * Shared PTL-retry compaction helper used by both the cache-sharing
 * (attempt 1) and simplified (attempt 2) paths in summarizeConversation.
 *
 * On prompt-too-long (PTL) errors, drops the oldest ~25 % of messages and
 * retries up to `maxRetries` times. The `prepareFn` callback encapsulates
 * the path-specific message preparation (image cleaning, tool→text conversion).
 */
async function compactWithPTLRetry(
	messagesForAPI: ApiMessage[],
	prompt: string,
	apiHandler: ApiHandler,
	condenseInstructions: string,
	prepareFn: (
		msgs: ApiMessage[],
		instr: string,
	) => { role: string; content: string | Anthropic.Messages.ContentBlockParam[] }[],
	metadata: ApiHandlerCreateMessageMetadata | undefined,
	maxRetries: number,
): Promise<{ summary: string; cost: number; outputTokens: number }> {
	let retryMessages = messagesForAPI
	for (let retry = 0; retry <= maxRetries; retry++) {
		try {
			const requestMessages = prepareFn(retryMessages, condenseInstructions)
			const stream = apiHandler.createMessage(
				prompt,
				requestMessages as Anthropic.Messages.MessageParam[],
				metadata,
			)

			let s = ""
			let c = 0
			let t = 0
			for await (const chunk of stream) {
				if (chunk.type === "text") {
					s += chunk.text
				} else if (chunk.type === "usage") {
					c = chunk.totalCost ?? 0
					t = chunk.outputTokens ?? 0
				}
			}
			if (s.trim().length > 0) {
				return { summary: s.trim(), cost: c, outputTokens: t }
			}
			return { summary: "", cost: c, outputTokens: t }
		} catch (err) {
			const errMsg = getErrorMessage(err)
			const errStatus = (err as any)?.status ?? 0
			const isPTL =
				errStatus === 413 ||
				errStatus === 400 ||
				/prompt.*(too.?long|length)|context.*(length|exceed)|maximum.*(context|token)|reduce.*(length|message)/i.test(
					errMsg,
				)

			if (isPTL && retry < maxRetries && retryMessages.length > 2) {
				const dropCount = Math.max(2, Math.floor(retryMessages.length * 0.25))
				retryMessages = retryMessages.slice(
					-Math.max(2, retryMessages.length - dropCount),
				)
				logger.warn("Condense", 
					`[summarizeConversation] PTL retry ${retry + 1}/${maxRetries}: ` +
						`dropping oldest messages, ${retryMessages.length} remaining`,
				)
				continue
			}
			throw err
		}
	}
	return { summary: "", cost: 0, outputTokens: 0 }
}

export async function summarizeConversation(options: SummarizeConversationOptions): Promise<SummarizeResponse> {
	const {
		messages,
		apiHandler,
		systemPrompt,
		taskId,
		isAutomaticTrigger,
		customCondensingPrompt,
		metadata,
		environmentDetails,
		filesReadByRoo,
		cwd,
		rooIgnoreController,
	} = options
	TelemetryService.instance.captureContextCondensed(
		taskId,
		isAutomaticTrigger ?? false,
		!!customCondensingPrompt?.trim(),
	)

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	// Get messages to summarize (all messages since the last summary, if any)
	const messagesToSummarize = getMessagesSinceLastSummary(messages)

	if (messagesToSummarize.length <= 1) {
		const error =
			messages.length <= 1
				? t("common:errors.condense_not_enough_messages")
				: t("common:errors.condensed_recently")
		return { ...response, error }
	}

	// Check if there's a recent summary in the messages (edge case)
	const recentSummaryExists = messagesToSummarize.some((message: ApiMessage) => message.isSummary)

	if (recentSummaryExists && messagesToSummarize.length <= 2) {
		const error = t("common:errors.condensed_recently")
		return { ...response, error }
	}

	// Use custom prompt if provided and non-empty, otherwise use the default CONDENSE prompt
	// This respects user's custom condensing prompt setting
	const condenseInstructions = customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE

	// Inject synthetic tool_results for orphan tool_calls to prevent API rejections
	// (e.g., when user triggers condense after receiving attempt_completion but before responding)
	const messagesWithToolResults = injectSyntheticToolResults(messagesToSummarize)

	// Filter out previous summary messages to prevent "summary of summary"
	// information drift. Each condense step should summarize raw conversation
	// content, not re-distill a prior distillation.
	const messagesForLLM = messagesWithToolResults.filter((m) => !m.isSummary)

	// Validate that the API handler supports message creation
	if (!apiHandler || typeof apiHandler.createMessage !== "function") {
		logger.error("Condense", "API handler is invalid for condensing. Cannot proceed.")
		const error = t("common:errors.condense_handler_invalid")
		return { ...response, error }
	}

	let summary = ""
	let cost = 0
	let outputTokens = 0

	// --- Cache-sharing path (attempt 1) ---
	// Reuses the main conversation's system prompt and tools so the provider can
	// cache-hit against the existing prompt prefix. Falls back to the simplified
	// path if this fails (e.g., unsupported provider, error).
	const hasTools = metadata?.tools && metadata.tools.length > 0
	const canAttemptCacheSharing = hasTools && systemPrompt?.length > 0

	if (canAttemptCacheSharing) {
		try {
			const cacheResult = await compactWithPTLRetry(
				messagesForLLM,
				systemPrompt,
				apiHandler,
				condenseInstructions,
				(msgs, instr) => {
					const userMessage: Anthropic.MessageParam = { role: "user", content: instr }
					const cleaned = maybeRemoveImageBlocks([...msgs, userMessage], apiHandler)
					return cleaned.map(({ role, content }) => ({ role, content }))
				},
				metadata,
				3,
			)
			if (cacheResult.summary) {
				summary = cacheResult.summary
				cost = cacheResult.cost
				outputTokens = cacheResult.outputTokens
				logger.info("Condense",
					`[summarizeConversation] Cache-sharing path succeeded: outputTokens=${outputTokens}`,
				)
			}
		} catch (err) {
			logger.warn("Condense", 
				"[summarizeConversation] Cache-sharing path failed, falling back to simplified path:",
				getErrorMessage(err),
			)
		}
	}

	// --- Simplified fallback path (attempt 2 if cache-sharing failed) ---
	if (!summary) {
		const promptToUse = getSummaryPrompt()
		try {
			const fallbackResult = await compactWithPTLRetry(
				messagesForLLM,
				promptToUse,
				apiHandler,
				condenseInstructions,
				(msgs, instr) => {
					const finalRequestMessage: Anthropic.MessageParam = {
						role: "user",
						content: instr,
					}
					const transformed = transformMessagesForCondensing(
						maybeRemoveImageBlocks([...msgs, finalRequestMessage], apiHandler),
					)
					return transformed.map(({ role, content }) => ({ role, content }))
				},
				undefined,
				3,
			)
			summary = fallbackResult.summary
			cost = fallbackResult.cost
			outputTokens = fallbackResult.outputTokens
		} catch (error) {
			// Non-PTL error or exhausted retries — fail
			logger.error("Condense", "Error during condensing API call:", error)
			const errorMessage = getErrorMessage(error)

			let errorDetails = ""
			if (error instanceof Error) {
				errorDetails = `Error: ${error.message}`
				const anyError = error as unknown as Record<string, unknown>
				if (anyError.status) {
					errorDetails += `\n\nHTTP Status: ${anyError.status}`
				}
				if (anyError.code) {
					errorDetails += `\nError Code: ${anyError.code}`
				}
				if (anyError.response) {
					try {
						errorDetails += `\n\nAPI Response:\n${JSON.stringify(anyError.response, null, 2)}`
					} catch {
						errorDetails += `\n\nAPI Response: [Unable to serialize]`
					}
				}
				if (anyError.body) {
					try {
						errorDetails += `\n\nResponse Body:\n${JSON.stringify(anyError.body, null, 2)}`
					} catch {
						errorDetails += `\n\nResponse Body: [Unable to serialize]`
					}
				}
			} else {
				errorDetails = String(error)
			}

			return {
				...response,
				cost,
				error: t("common:errors.condense_api_failed", { message: errorMessage }),
				errorDetails,
			}
		}
	}

	// Strip <analysis> scratchpad and format <summary> tags into readable headers
	summary = formatCompactSummary(summary)

	if (summary.length === 0) {
		const error = t("common:errors.condense_failed")
		return { ...response, cost, error }
	}

	// Extract command blocks from the first message (original task)
	// These represent active workflows that must persist across condensings
	const firstMessage = messages[0]
	const commandBlocks = firstMessage ? extractCommandBlocks(firstMessage) : ""

	// Build the summary content as separate text blocks
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Conversation Summary\n${summary}` },
	]

	// Add command blocks (active workflows) in their own system-reminder block if present
	if (commandBlocks) {
		summaryContent.push({
			type: "text",
			text: `<system-reminder>
## Active Workflows
The following directives must be maintained across all future condensings:
${commandBlocks}
</system-reminder>`,
		})
	}

	// Generate and add folded file context (smart code folding) if file paths are provided
	// Each file gets its own <system-reminder> block as a separate content block
	if (filesReadByRoo && filesReadByRoo.length > 0 && cwd) {
		try {
			const foldedResult = await generateFoldedFileContext(filesReadByRoo, {
				cwd,
				rooIgnoreController,
			})
			if (foldedResult.sections.length > 0) {
				for (const section of foldedResult.sections) {
					if (section.trim()) {
						summaryContent.push({
							type: "text",
							text: section,
						})
					}
				}
			}
		} catch (error) {
			logger.error("Condense", "[summarizeConversation] Failed to generate folded file context:", error)
			// Continue without folded context - non-critical failure
		}
	}

	// Add environment details as a separate text block if provided AND this is an automatic trigger.
	// For manual condensing, fresh environment details will be injected on the next turn.
	// For automatic condensing, the API request is already in progress so we need them in the summary.
	if (isAutomaticTrigger && environmentDetails?.trim()) {
		summaryContent.push({
			type: "text",
			text: environmentDetails,
		})
	}

	// Generate a unique condenseId for this summary
	const condenseId = crypto.randomUUID()

	// Use the last message's timestamp + 1 to ensure unique timestamp for summary.
	// The summary goes at the end of all messages.
	const lastMsgTs = messages[messages.length - 1]?.ts ?? Date.now()

	const summaryMessage: ApiMessage = {
		role: "user", // Fresh start model: summary is a user message
		content: summaryContent,
		ts: lastMsgTs + 1, // Unique timestamp after last message
		isSummary: true,
		condenseId, // Unique ID for this summary, used to track which messages it replaces
		compactMetadata: {
			trigger: isAutomaticTrigger ? "auto" : "manual",
			source: "llm",
			preCompactTokenCount: messages.length, // message count as rough pre-compact metric
			messagesSummarized: messagesForLLM.length,
			timestamp: Date.now(),
		},
	}

	// NON-DESTRUCTIVE CONDENSE — APPEND-BASED (cache-preserving):
	// Tag only messages since the LAST summary with condenseParent,
	// so previous summaries stay visible and form a stable cache prefix.
	//
	// Storage structure after condense:
	// [msg1(A), ..., msgN(A), summaryA, msgN+1(B), ..., msgM(B), summaryB]
	//
	// Effective for API (filtered by getEffectiveApiHistory):
	// [summaryA, summaryB]  ← Append-based! summaryA is cache-stable.

	// Find the last summary before this compaction — its timestamp tells us
	// which messages are already represented by an existing summary.
	const lastSummaryBefore = findLast(messages, (m) => m.isSummary === true)
	const lastSummaryTs = lastSummaryBefore?.ts ?? 0

	const newMessages = messages.map((msg) => {
		// Already condensed by a previous summary — leave the chain intact
		if (msg.condenseParent) return msg
		// Summary messages stay visible so the cache prefix remains stable
		if (msg.isSummary) return msg
		// Message was already covered by the previous summary — don't re-tag
		if (lastSummaryBefore && typeof msg.ts === "number" && msg.ts <= lastSummaryTs) return msg
		// Tag this message as condensed by the new summary
		return { ...msg, condenseParent: condenseId }
	})

	// Append the summary message at the end
	newMessages.push(summaryMessage)

	// Count the tokens in the context for the next API request
	// After condense, the context will contain: system prompt + summary + tool definitions
	const systemPromptMessage: ApiMessage = { role: "user", content: systemPrompt }

	// Count actual summaryMessage content directly instead of using outputTokens as a proxy
	// This ensures we account for wrapper text (## Conversation Summary, <system-reminder>, <environment_details>)
	const contextBlocks = [systemPromptMessage, summaryMessage].flatMap((message) =>
		typeof message.content === "string" ? [{ text: message.content, type: "text" as const }] : message.content,
	)

	const messageTokens = await apiHandler.countTokens(contextBlocks)

	// Count tool definition tokens if tools are provided
	let toolTokens = 0
	if (metadata?.tools && metadata.tools.length > 0) {
		const toolsText = JSON.stringify(metadata.tools)
		toolTokens = await apiHandler.countTokens([{ text: toolsText, type: "text" }])
	}

	const newContextTokens = messageTokens + toolTokens
	return { messages: newMessages, summary, cost, newContextTokens, condenseId }
}

/**
 * Returns the list of all messages since the last summary message, including the summary.
 * Returns all messages if there is no summary.
 *
 * Note: Summary messages are always created with role: "user" (fresh-start model),
 * so the first message since the last summary is guaranteed to be a user message.
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
	const lastSummaryIndexReverse = [...messages].reverse().findIndex((message) => message.isSummary)

	if (lastSummaryIndexReverse === -1) {
		return messages
	}

	const lastSummaryIndex = messages.length - lastSummaryIndexReverse - 1
	return messages.slice(lastSummaryIndex)
}

/**
 * Filters the API conversation history to get the "effective" messages to send to the API.
 *
 * Fresh Start Model:
 * - When a summary exists, return only messages from the summary onwards (fresh start)
 * - Messages with a condenseParent pointing to an existing summary are filtered out
 *
 * Messages with a truncationParent that points to an existing truncation marker are also filtered out,
 * as they have been hidden by sliding window truncation.
 *
 * This allows non-destructive condensing and truncation where messages are tagged but not deleted,
 * enabling accurate rewind operations while still sending condensed/truncated history to the API.
 *
 * @param messages - The full API conversation history including tagged messages
 * @returns The filtered history that should be sent to the API
 */
/**
 * Filters orphan tool_result blocks from messages by building a set of valid
 * tool_use IDs. A tool_result is "orphaned" if its tool_use_id doesn't match
 * any tool_use block present in the message set. Such orphans cause API errors.
 *
 * This is applied in both the fresh-start and the fallback code path so that
 * orphan tool_results are never leaked to the API.
 */
function filterOrphanToolResults(messages: ApiMessage[]): ApiMessage[] {
	// Collect all tool_use IDs from assistant messages
	const toolUseIds = new Set<string>()
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && (block as Anthropic.Messages.ToolUseBlockParam).id) {
					toolUseIds.add((block as Anthropic.Messages.ToolUseBlockParam).id)
				}
			}
		}
	}

	// When toolUseIds is empty, every tool_result is an orphan
	// (its tool_use was condensed or truncated away).

	return messages
		.map((msg) => {
			if (msg.role === "user" && Array.isArray(msg.content)) {
				const filteredContent = msg.content.filter((block) => {
					if (block.type === "tool_result") {
						return toolUseIds.has((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id)
					}
					return true
				})
				if (filteredContent.length === 0) return null
				if (filteredContent.length !== msg.content.length) {
					return { ...msg, content: filteredContent }
				}
			}
			return msg
		})
		.filter((msg): msg is ApiMessage => msg !== null)
}

export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
	// Find the most recent summary message
	const lastSummary = findLast(messages, (msg) => msg.isSummary === true)

	if (lastSummary) {
		// Append-based model: return ALL summary messages (they stay visible
		// for cache prefix stability) plus any non-condensed messages after
		// the last summary (the working window).
		//
		// Storage: [msg1(A), ..., msgN(A), summaryA, msgN+1(B), ..., msgM(B), summaryB]
		// Effective: [summaryA, summaryB]   ← all summaries visible, cache-prefix stable

		const allSummaries = messages.filter((msg) => msg.isSummary && !msg.condenseParent)

		// Working window: messages after the last summary that aren't summaries
		// and haven't been condensed yet (typically empty right after compaction,
		// grows as the conversation continues).
		const summaryIndex = messages.indexOf(lastSummary)
		const workingWindow = messages.slice(summaryIndex).filter(
			(msg) => !msg.isSummary && !msg.condenseParent,
		)

		let effectiveMessages = [...allSummaries, ...workingWindow]
		effectiveMessages = filterOrphanToolResults(effectiveMessages)

		// Still need to filter out any truncated messages within this range
		const existingTruncationIds = new Set<string>()
		for (const msg of effectiveMessages) {
			if (msg.isTruncationMarker && msg.truncationId) {
				existingTruncationIds.add(msg.truncationId)
			}
		}

		return effectiveMessages.filter((msg) => {
			// Filter out truncated messages if their truncation marker exists
			if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
				return false
			}
			return true
		})
	}

	// No summary - filter based on condenseParent and truncationParent as before
	// This handles the case of orphaned condenseParent tags (summary was deleted via rewind)

	// Collect all condenseIds of summaries that exist in the current history
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that exist in the current history
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Filter out messages whose condenseParent points to an existing summary
	// or whose truncationParent points to an existing truncation marker.
	// Messages with orphaned parents (summary/marker was deleted) are included.
	const filteredForParents = messages.filter((msg) => {
		// Filter out condensed messages if their summary exists
		if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
			return false
		}
		// Filter out truncated messages if their truncation marker exists
		if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
			return false
		}
		return true
	})

	// Apply orphan tool_result filtering (defense-in-depth — orphan tool_use
	// blocks are normally prevented by expandTruncationToAtomicUnits, but
	// covering both paths guards against edge cases).
	return filterOrphanToolResults(filteredForParents)
}

/**
 * Cleans up orphaned condenseParent and truncationParent references after a truncation operation (rewind/delete).
 * When a summary message or truncation marker is deleted, messages that were tagged with its ID
 * should have their parent reference cleared so they become active again.
 *
 * This function should be called after any operation that truncates the API history
 * to ensure messages are properly restored when their summary or truncation marker is deleted.
 *
 * @param messages - The API conversation history after truncation
 * @returns The cleaned history with orphaned condenseParent and truncationParent fields cleared
 */
export function cleanupAfterTruncation(messages: ApiMessage[]): ApiMessage[] {
	// Collect all condenseIds of summaries that still exist
	const existingSummaryIds = new Set<string>()
	// Collect all truncationIds of truncation markers that still exist
	const existingTruncationIds = new Set<string>()

	for (const msg of messages) {
		if (msg.isSummary && msg.condenseId) {
			existingSummaryIds.add(msg.condenseId)
		}
		if (msg.isTruncationMarker && msg.truncationId) {
			existingTruncationIds.add(msg.truncationId)
		}
	}

	// Clear orphaned parent references for messages whose summary or truncation marker was deleted
	return messages.map((msg) => {
		let needsUpdate = false

		// Check for orphaned condenseParent
		if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
			needsUpdate = true
		}

		// Check for orphaned truncationParent
		if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
			needsUpdate = true
		}

		if (needsUpdate) {
			// Create a new object without orphaned parent references
			const { condenseParent, truncationParent, ...rest } = msg
			const result: ApiMessage = rest as ApiMessage

			// Keep condenseParent if its summary still exists
			if (condenseParent && existingSummaryIds.has(condenseParent)) {
				result.condenseParent = condenseParent
			}

			// Keep truncationParent if its truncation marker still exists
			if (truncationParent && existingTruncationIds.has(truncationParent)) {
				result.truncationParent = truncationParent
			}

			return result
		}
		return msg
	})
}

export type { PartialCompactDirection } from "./prompt"

export type SummarizePartialOptions = {
	messages: ApiMessage[]
	/** The index of the pivot message. All messages before or after (depending on direction) are summarized. */
	pivotIndex: number
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	/** 'up_to': summarize before pivot, keep after. 'from': keep before, summarize after. */
	direction: PartialCompactDirection
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
}

/**
 * Performs a partial compaction around a selected message index.
 *
 * - direction 'from': summarizes messages AFTER the pivot, keeps earlier ones.
 *   Prompt cache for kept (earlier) messages is preserved.
 * - direction 'up_to': summarizes messages BEFORE the pivot, keeps later ones.
 *   Prompt cache is invalidated since the summary precedes the kept messages.
 */
export async function summarizePartialConversation(
	options: SummarizePartialOptions,
): Promise<SummarizeResponse> {
	const {
		messages,
		pivotIndex,
		apiHandler,
		systemPrompt: _systemPrompt,
		taskId: _taskId,
		direction,
		customCondensingPrompt,
		metadata: _metadata,
	} = options

	const response: SummarizeResponse = { messages, cost: 0, summary: "" }

	if (pivotIndex < 1 || pivotIndex >= messages.length - 1) {
		return { ...response, error: "Invalid pivot index for partial compaction" }
	}

	const messagesToSummarize =
		direction === "up_to"
			? messages.slice(0, pivotIndex)
			: messages.slice(pivotIndex)

	const messagesToKeep =
		direction === "up_to"
			? messages.slice(pivotIndex)
			: messages.slice(0, pivotIndex)

	if (messagesToSummarize.length === 0) {
		return {
			...response,
			error:
				direction === "up_to"
					? "Nothing to summarize before the selected message."
					: "Nothing to summarize after the selected message.",
		}
	}

	const condenseId = crypto.randomUUID()
	const condenseInstructions =
		customCondensingPrompt?.trim() || supportPrompt.default.CONDENSE

	const finalRequestMessage: Anthropic.MessageParam = {
		role: "user",
		content: condenseInstructions,
	}

	// For 'up_to': send only messagesToSummarize (cache hit on prefix)
	// For 'from': send all messages (cache on early prefix)
	const apiMessages =
		direction === "up_to" ? messagesToSummarize : messages

	const messagesWithToolResults = injectSyntheticToolResults(apiMessages)
	const messagesWithTextToolBlocks = transformMessagesForCondensing(
		maybeRemoveImageBlocks([...messagesWithToolResults, finalRequestMessage], apiHandler),
	)
	const requestMessages = messagesWithTextToolBlocks.map(({ role, content }) => ({ role, content }))

	const promptToUse = getPartialCompactPrompt(undefined, direction)

	let summary = ""
	let cost = 0
	let _outputTokens = 0

	try {
		const stream = apiHandler.createMessage(promptToUse, requestMessages)
		for await (const chunk of stream) {
			if (chunk.type === "text") {
				summary += chunk.text
			} else if (chunk.type === "usage") {
				cost = chunk.totalCost ?? 0
				_outputTokens = chunk.outputTokens ?? 0
			}
		}
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		return {
			...response,
			cost,
			error: `Partial condensation failed: ${errorMessage}`,
		}
	}

	summary = formatCompactSummary(summary.trim())
	if (summary.length === 0) {
		return { ...response, cost, error: "Partial condensation produced empty summary" }
	}

	// Build the summary content
	const summaryContent: Anthropic.Messages.ContentBlockParam[] = [
		{ type: "text", text: `## Conversation Summary (partial)\n${summary}` },
	]

	// 'up_to': summary goes BEFORE kept messages (prefix-partial)
	// 'from': summary goes AFTER kept messages (suffix-partial)
	const lastKeptTs = messagesToKeep[messagesToKeep.length - 1]?.ts ?? Date.now()
	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryContent,
		ts: direction === "up_to" ? lastKeptTs - messagesToSummarize.length - 1 : lastKeptTs + 1,
		isSummary: true,
		condenseId,
		compactMetadata: {
			trigger: "manual",
			source: "llm",
			preCompactTokenCount: messages.length,
			messagesSummarized: messagesToSummarize.length,
			preservedSegment:
				direction === "from"
					? { headIndex: 0, tailIndex: pivotIndex - 1 }
					: { headIndex: pivotIndex, tailIndex: messages.length - 1 },
			timestamp: Date.now(),
		},
	}

	// Tag summarized messages with condenseParent
	const newMessages =
		direction === "up_to"
			? [
					...messagesToSummarize.map((msg) =>
						msg.condenseParent ? msg : { ...msg, condenseParent: condenseId },
					),
					summaryMessage,
					...messagesToKeep,
				]
			: [
					...messagesToKeep,
					...messagesToSummarize.map((msg) =>
						msg.condenseParent ? msg : { ...msg, condenseParent: condenseId },
					),
					summaryMessage,
				]

	return {
		messages: newMessages,
		summary,
		cost,
		condenseId,
	}
}

