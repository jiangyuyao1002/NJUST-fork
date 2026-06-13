import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { logger } from "../../shared/logger"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@njust-ai/core/providers"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { preprocessMessages } from "./preprocess"
import { postCompactRestore } from "./postCompactRestore"
import { shouldSkipCompactForCache, getAdjustedCompactThreshold } from "../condense/cacheAwareCompact"
import { globalCacheMetrics } from "../../utils/cacheMetrics"
import { analyzeContextTokens } from "./contextAnalysis"
import { generateSuggestions, formatSuggestions } from "./contextSuggestions"
import { ToolHookManager } from "../tools/ToolHookManager"
import { buildContextHierarchy } from "./contextHierarchy"

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
import { TOKEN_BUFFER_TOKENS, estimateTokenCount, truncateConversation } from "./truncation"
import { tryBuildLightweightSummary, trySessionMemoryCompaction } from "./lightweightSummary"

export const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
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
	/** Optional array of file paths read by Njust-AI during the task (will be folded via tree-sitter) */
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
	const lastMessage = preprocessedMessages[preprocessedMessages.length - 1]!
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
			logger.warn(
				"ContextManagement",
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
			effectiveThreshold = autoCondenseContextPercent
		}
	}
	// If no specific threshold is found for the profile, fall back to global setting

	// Run context analysis for observability before compaction decisions
	;(function () {
		const analysisResult = analyzeContextTokens(preprocessedMessages, 0)
		const suggestions = generateSuggestions(
			analysisResult.breakdown,
			analysisResult.duplicateReads,
			analysisResult.estimatedDuplicateReadTokens,
			analysisResult.largeToolResults,
			analysisResult.summaryMessageCount,
		)
		logCompactEvent("context_analysis", {
			toolResultPct: Math.round(
				(analysisResult.breakdown.toolResultTokens / Math.max(1, analysisResult.breakdown.totalTokens)) * 100,
			),
			summaryPct: Math.round(
				(analysisResult.breakdown.summaryTokens / Math.max(1, analysisResult.breakdown.totalTokens)) * 100,
			),
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
		const adjustedThreshold =
			effectiveCacheReadTokens !== undefined
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
			const preHookResult = await ToolHookManager.instance.runPreCompactHooks({
				taskId,
				messageCount: preprocessedMessages.length,
				tokenCount: prevContextTokens,
			})
			if (!preHookResult.allow) {
				logger.warn(
					"ContextManagement",
					"[Context Management] Pre-compact hook aborted compaction: " +
						(preHookResult.reason || "unknown reason"),
				)
				logCompactEvent("compact_aborted_hook", { reason: preHookResult.reason })
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
				if (
					effectiveCacheReadTokens !== undefined &&
					shouldSkipCompactForCache(effectiveCacheReadTokens, cacheAwareTokensBase)
				) {
					logger.info(
						"ContextManagement",
						`Skipping auto-compact: high prompt cache hit rate ` +
							`(${((effectiveCacheReadTokens / Math.max(1, cacheAwareTokensBase)) * 100).toFixed(1)}%). ` +
							`Compression would break cache and increase costs.`,
					)
					// Preserve cache by skipping condensation, but do not bypass hard context-window safety.
					// If already over budget, fall through to truncation logic below.
					if (prevContextTokens <= allowedTokens) {
						return {
							messages: preprocessedMessages,
							prevContextTokens,
							summary: "",
							cost: 0,
							compactFailures,
						}
					}
				}
				// Circuit breaker: if condensation has failed too many times consecutively,
				// skip it and fall through to truncation to avoid wasting API calls
				else if (compactFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
					logger.warn(
						"ContextManagement",
						`[Context Management] Circuit breaker triggered: ` +
							`${compactFailures} consecutive condensation failures. ` +
							`Falling back to forced truncation.`,
					)
					// Force aggressive truncation (50% removal) with hierarchy-enhanced scoring
					const hierarchy = buildContextHierarchy(preprocessedMessages, taskId)
					const truncationResult = truncateConversation(
						preprocessedMessages,
						0.5,
						taskId,
						hierarchy ?? undefined,
					)
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
					const smResult = tryBuildLightweightSummary(preprocessedMessages, taskId, allowedTokens)
					if (smResult) {
						logCompactEvent("compact_sm_success", { method: "lightweight_summary" })
						// Post-compact hooks (fire-and-forget)
						ToolHookManager.instance
							.runPostCompactHooks({
								taskId,
								messageCountBefore: preprocessedMessages.length,
								messageCountAfter: smResult.messages.length,
								tokenCountBefore: prevContextTokens,
								tokenCountAfter: 0, // SM-compact has no API call
							})
							.catch((err: unknown) => {
								logger.warn("ContextManagement", "Failed to capture compact telemetry", err)
								TelemetryService.reportError(
									err instanceof Error ? err : new Error(String(err)),
									TelemetryEventName.UTILITY_ERROR,
								)
							})
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
					const smMemoryResult = await trySessionMemoryCompaction(preprocessedMessages, cwd, allowedTokens)
					if (smMemoryResult) {
						logCompactEvent("compact_sm_success", { method: "session_memory" })
						// Post-compact hooks (fire-and-forget)
						ToolHookManager.instance
							.runPostCompactHooks({
								taskId,
								messageCountBefore: preprocessedMessages.length,
								messageCountAfter: smMemoryResult.messages.length,
								tokenCountBefore: prevContextTokens,
								tokenCountAfter: 0,
							})
							.catch((err: unknown) => {
								logger.warn("ContextManagement", "Failed to capture memory compact telemetry", err)
								TelemetryService.reportError(
									err instanceof Error ? err : new Error(String(err)),
									TelemetryEventName.UTILITY_ERROR,
								)
							})
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
						logger.warn(
							"ContextManagement",
							`[Context Management] Condensation failed (attempt ${compactFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${result.error}`,
						)
						error = result.error
						errorDetails = result.errorDetails
						cost = result.cost
					} else {
						// Success - reset circuit breaker counter
						logCompactEvent("compact_llm_success", { method: "llm_condensation" })
						// Post-compact hooks (fire-and-forget)
						ToolHookManager.instance
							.runPostCompactHooks({
								taskId,
								messageCountBefore: preprocessedMessages.length,
								messageCountAfter: result.messages.length,
								tokenCountBefore: prevContextTokens,
								tokenCountAfter: result.newContextTokens ?? prevContextTokens,
							})
							.catch((err: unknown) => {
								logger.warn("ContextManagement", "Failed to capture compact telemetry", err)
								TelemetryService.reportError(
									err instanceof Error ? err : new Error(String(err)),
									TelemetryEventName.UTILITY_ERROR,
								)
							})
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
					return estimateTokenCount([{ type: "text", text: content }], apiHandler)
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
	return {
		messages: preprocessedMessages,
		summary: "",
		cost,
		prevContextTokens,
		error,
		errorDetails,
		compactFailures,
	}
}
