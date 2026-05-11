import { classifyApiError, type ApiErrorKind } from "../errors/apiErrorClassifier"
import { mapErrorToRecoveryAction, shouldRetryCapacityError, type RecoveryAction, type QuerySource } from "../errors/recoveryStrategyMap"
import { appendRetryEvent } from "../errors/retryPersistence"
import { reactiveCompactMessages } from "../context-management/reactiveCompact"
import { TaskState } from "./TaskStateMachine"
import { logger } from "../../shared/logger"
import type { TypedBlock } from "../assistant-message/types"

import type { Task } from "./Task"
import { getErrorMessage } from "../../shared/error-utils"

/**
 * Structured result from error recovery handling.
 * Task.ts uses this to decide whether to retry, fallback, or fall through to manual handling.
 */
export type RecoveryResult =
	| { action: "retry"; nextAttempt: number }
	| { action: "model_fallback"; errorCategory: ApiErrorKind; reason: string }
	| { action: "fallthrough" }

/**
 * ErrorRecoveryHandler encapsulates the error classification, recovery strategy
 * selection, circuit breaker logic, and retry event recording extracted from
 * the `attemptApiRequest` catch block in Task.ts.
 *
 * Uses the delegation pattern: accesses Task instance properties via `this.task`.
 */
export class ErrorRecoveryHandler {
	constructor(private task: Task) {}

	/**
	 * Handle an API call error and return a structured recovery decision.
	 *
	 * Extracted from the switch(recoveryAction) block in attemptApiRequest's catch.
	 * The caller (Task.ts) is responsible for acting on the result:
	 * - { action: "retry", nextAttempt } → yield* this.attemptApiRequest(nextAttempt)
	 * - { action: "fallthrough" } → continue to the existing backoff / user-prompt logic
	 */
	async handleApiError(error: unknown, retryAttempt: number, querySource: QuerySource = "user_query"): Promise<RecoveryResult> {
		const classified = classifyApiError(error)
	
		// 529 capacity errors: background queries (auto_compact) should not retry
		// to avoid cascade amplification during service degradation.
		if (classified === "capacity" && !shouldRetryCapacityError(querySource)) {
			return { action: "fallthrough" }
		}
	
		// model_overloaded: background tasks should not retry to avoid amplification
		if (classified === "model_overloaded" && !shouldRetryCapacityError(querySource)) {
			return { action: "fallthrough" }
		}
	
		const recoveryAction = mapErrorToRecoveryAction(classified, retryAttempt)
	
		// Record the retry event for diagnostics
		await appendRetryEvent(this.task.globalStoragePath, {
			taskId: this.task.taskId,
			retryAttempt,
			errorKind: classified,
			errorMessage: getErrorMessage(error),
			timestamp: Date.now(),
		})
	
		switch (recoveryAction) {
			case "reactive_compact_then_retry":
			case "retry_with_continuation": {
				this.task.forceTaskState(TaskState.COMPACTING)
				await this.applyReactiveCompaction(recoveryAction, retryAttempt)

				if (recoveryAction === "retry_with_continuation") {
					// For max_output_tokens: preserve partial output and add continuation cue.
					// The StreamingToolExecutor's withheld results (if any) are kept in place —
					// they will be drained and included in the next API request by Task.ts.
				logger.warn("ErrorRecoveryHandler",
					`max_output_tokens hit for task ${this.task.taskId} (attempt ${retryAttempt + 1}/3). ` +
						`Preserving partial output and adding continuation cue...`,
				)
					await this.addContinuationCue()
				}

				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
			case "context_window_recover": {
				this.task.forceTaskState(TaskState.COMPACTING)
				logger.warn("ErrorRecoveryHandler",
					`Context window exceeded for task ${this.task.taskId}, model ${this.task.api.getModel().id}. ` +
						`Retry attempt ${retryAttempt + 1}. ` +
						`Attempting automatic truncation...`,
				)
				await this.task.handleContextWindowExceededError()
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
			case "immediate_retry": {
				// Stale connection (ECONNRESET/EPIPE): retry immediately without
				// incrementing the attempt counter so it doesn't consume a
				// regular retry slot.
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			// === New recovery actions (Task 4.2) ===
	
			case "strip_media_retry": {
				// media_too_large: scan conversation for large media content,
				// remove image/file blocks, then retry.
				logger.warn("ErrorRecoveryHandler",
					`Media too large for task ${this.task.taskId} (attempt ${retryAttempt + 1}/2). ` +
						`Stripping media content from messages...`,
				)
				await this.stripLargeMediaFromHistory()
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "overloaded_backoff": {
				// model_overloaded (503): exponential backoff starting at 5s, max 120s.
				// After 3 failures, the strategy map returns "none" → fallback candidate.
				const backoffMs = Math.min(5000 * Math.pow(2, retryAttempt), 120_000)
				logger.warn("ErrorRecoveryHandler",
					`Model overloaded for task ${this.task.taskId} (attempt ${retryAttempt + 1}/3). ` +
						`Backing off for ${backoffMs / 1000}s...`,
				)
				await this.delay(backoffMs)
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "inject_tool_hint_retry": {
				// invalid_tool_use: inject correction hint so the model fixes its tool call.
				// On 2nd retry (retryAttempt >= 1), also include a usage example.
				const hint =
					"The previous tool call had an invalid format. " +
					"Please strictly follow the tool schema and provide all required parameters."
				const exampleSuffix =
					retryAttempt >= 1
						? "\n\nExample of correct tool use: {\"tool\": \"tool_name\", \"parameters\": {\"param1\": \"value1\"}}"
						: ""
				logger.warn("ErrorRecoveryHandler",
					`Invalid tool use for task ${this.task.taskId} (attempt ${retryAttempt + 1}/3). ` +
						`Injecting correction hint...`,
				)
				await this.task.addToApiConversationHistory({
					role: "user",
					content: hint + exampleSuffix,
				})
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "content_policy_reject": {
				// content_policy: do NOT retry. Notify user that content was rejected.
				logger.warn("ErrorRecoveryHandler",
					`Content rejected by safety/policy filter for task ${this.task.taskId}. No retry.`,
				)
				await this.task.say(
					"error",
					"Your request was rejected by the content safety policy. " +
						"Please modify your request and try again.",
				)
				return { action: "fallthrough" }
			}
	
			case "partial_continue": {
				// partial_response: keep existing content, send "continue" to resume generation.
				logger.warn("ErrorRecoveryHandler",
					`Partial response received for task ${this.task.taskId} (attempt ${retryAttempt + 1}/3). ` +
						`Sending continuation request...`,
				)
				await this.addContinuationCue()
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "server_error_backoff": {
				// server_error (500): exponential backoff with diagnostics logging.
				const backoffMs = Math.min(2000 * Math.pow(2, retryAttempt), 60_000)
				const errorMsg = getErrorMessage(error)
				logger.error("ErrorRecoveryHandler",
					`Server error 500 for task ${this.task.taskId} (attempt ${retryAttempt + 1}/5). ` +
						`Diagnostics: ${errorMsg}. ` +
						`Backing off for ${backoffMs / 1000}s...`,
				)
				await this.delay(backoffMs)
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "unknown_single_retry": {
				// unknown: log the full error, try once, then give up.
				const errorMsg = error instanceof Error ? error.stack || error.message : String(error)
				logger.warn("ErrorRecoveryHandler",
					`Unknown error for task ${this.task.taskId} (single retry). Full error: ${errorMsg}`,
				)
				return { action: "retry", nextAttempt: retryAttempt + 1 }
			}
	
			case "model_fallback": {
				// Retries exhausted for model_overloaded / timeout → suggest model fallback
				const classified2 = classifyApiError(error)
				logger.warn("ErrorRecoveryHandler",
					`Retries exhausted for ${classified2} errors on task ${this.task.taskId}. ` +
						`Recommending model fallback...`,
				)
				return {
					action: "model_fallback",
					errorCategory: classified2,
					reason: `Model retries exhausted after ${retryAttempt} attempts due to ${classified2}. Fallback recommended.`,
				}
			}
			
			case "backoff_retry":
			case "timeout_degrade":
			case "none":
			default:
				return { action: "fallthrough" }
		}
	}

	// ── Fallback Decision ───────────────────────────────────────────────

	/**
	 * Determine whether a model fallback should be triggered based on
	 * the error category and the current retry count.
	 *
	 * Returns true when retries for model_overloaded or timeout errors
	 * have been exhausted, indicating the caller should switch models.
	 */
	shouldTriggerFallback(errorCategory: ApiErrorKind, retryCount: number): boolean {
		// Only these error types are eligible for model fallback
		const fallbackEligible: ApiErrorKind[] = ["model_overloaded", "timeout", "server_error"]
		if (!fallbackEligible.includes(errorCategory)) {
			return false
		}

		const action = mapErrorToRecoveryAction(errorCategory, retryCount)
		return action === "model_fallback"
	}

	// ── Circuit Breaker ──────────────────────────────────────────────────

	/** Check whether context compaction should be bypassed due to repeated failures. */
	shouldBypassCondense(): boolean {
		return this.task.compactFailureCount >= this.task.maxCompactFailures
	}

	/** Record a compaction failure and announce degradation if threshold reached. */
	async recordCompactFailure(errorMessage: string): Promise<void> {
		this.task.compactFailureCount++
		await this.task.say("condense_context_error", errorMessage)
		if (this.task.compactFailureCount >= this.task.maxCompactFailures) {
			await this.task.say(
				"condense_context_error",
				"Context compaction failed repeatedly; temporarily degrading to truncation mode.",
			)
		}
	}

	/** Reset the compact failure counter (called after successful compaction). */
	resetCompactFailure(): void {
		this.task.compactFailureCount = 0
	}

	// ── Private helpers ──────────────────────────────────────────────────

	/**
	 * Apply reactive compaction to the conversation history when the error
	 * strategy calls for it.
	 */
	private async applyReactiveCompaction(recoveryAction: RecoveryAction, retryAttempt: number): Promise<void> {
		const modelInfo = this.task.api.getModel().info
		const contextWindow = modelInfo.contextWindow || 200_000
		const { contextTokens } = this.task.getTokenUsage()
		const contextPercent = contextWindow > 0 ? (100 * (contextTokens || 0)) / contextWindow : 90

		if (recoveryAction === "reactive_compact_then_retry" || retryAttempt >= 1) {
			const compacted = reactiveCompactMessages(this.task.apiConversationHistory, contextPercent)
			if (compacted !== this.task.apiConversationHistory) {
				await this.task.overwriteApiConversationHistory(compacted)
				// Force token usage recalculation after compaction to prevent
				// stale counts from triggering infinite compaction loops.
				this.task.tokenUsageSnapshot = this.task.getTokenUsage()
				this.task.tokenUsageSnapshotAt = Date.now()
			}
		}
	}

	/**
	 * Add a continuation cue to the conversation so the model picks up
	 * where it left off, unless a tool use is pending or cue already queued.
	 */
	private async addContinuationCue(): Promise<void> {
		const continuationCue =
			"Please continue from where you stopped. Do not repeat prior content; only provide the remaining continuation."
		const hasPendingToolUses = this.task.assistantMessageContent.some(
			(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
		)
		const last = this.task.apiConversationHistory[this.task.apiConversationHistory.length - 1]
		const alreadyQueued =
			last?.role === "user" && typeof last.content === "string" && last.content.includes(continuationCue)
		if (!hasPendingToolUses && !alreadyQueued) {
			// Inject error tool_result placeholders for any saved tool_use blocks that
			// lack corresponding results, preventing API protocol violations.
			const lastAssistant = [...this.task.apiConversationHistory]
				.reverse()
				.find((m) => m.role === "assistant")
			if (lastAssistant && Array.isArray(lastAssistant.content)) {
				const orphanedToolUses = lastAssistant.content.filter(
					(b) => b.type === "tool_use",
				)
				if (orphanedToolUses.length > 0) {
					const toolResults = orphanedToolUses.map((tu) => ({
						type: "tool_result" as const,
						tool_use_id: tu.id,
						content: "[Error: tool execution was interrupted by max_output_tokens limit]",
					}))
					await this.task.addToApiConversationHistory({
						role: "user",
						content: toolResults,
					})
				}
			}
			await this.task.addToApiConversationHistory({ role: "user", content: continuationCue })
		}
	}

	/**
	 * Strip large media content (images, files) from conversation history
	 * to allow the request to succeed within size limits.
	 * Replaces image/media blocks with a text placeholder.
	 */
	private async stripLargeMediaFromHistory(): Promise<void> {
		const history = this.task.apiConversationHistory
		let modified = false

		for (let i = 0; i < history.length; i++) {
			const msg = history[i]
			if (Array.isArray(msg.content)) {
				const filtered = msg.content.map((block) => {
					const b = block as unknown as TypedBlock
					if (b.type === "image" || b.type === "image_url" || (b.source as Record<string, unknown>)?.type === "base64") {
						modified = true
						return { type: "text" as const, text: "[Image removed: content too large for API]" }
					}
					return block
				})
				history[i] = { ...msg, content: filtered as typeof msg.content }
			}
		}

		if (modified) {
			await this.task.overwriteApiConversationHistory(history)
		}
	}

	/**
	 * Async delay helper for backoff strategies.
	 */
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms))
	}
}
