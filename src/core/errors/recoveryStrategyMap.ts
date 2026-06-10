import type { ApiErrorKind } from "./apiErrorClassifier"

export type RecoveryAction =
	| "reactive_compact_then_retry"
	| "retry_with_continuation"
	| "context_window_recover"
	| "backoff_retry"
	| "immediate_retry"
	| "timeout_degrade"
	// === New recovery actions (Task 4.2) ===
	| "strip_media_retry" // Remove/compress large media then retry
	| "overloaded_backoff" // Exponential backoff for model overload (5s start, 120s max)
	| "inject_tool_hint_retry" // Retry with tool-use correction hint injected
	| "content_policy_reject" // No retry; notify user about policy rejection
	| "partial_continue" // Send "continue" to resume partial response
	| "server_error_backoff" // Exponential backoff with diagnostics logging
	| "unknown_single_retry" // Single retry attempt, then give up
	| "model_fallback" // Switch to fallback model (triggered after retries exhausted)
	| "none"

/**
 * Maps a classified API error to a recovery action.
 *
 * Recovery strategies:
 * - reactive_compact_then_retry: Compact context then retry (for prompt too long)
 * - retry_with_continuation: Add continuation cue and retry (for max output tokens)
 * - context_window_recover: Truncate context window (for context exceeded)
 * - backoff_retry: Exponential backoff retry (for rate limits)
 * - immediate_retry: Retry immediately with no delay (for stale connections like ECONNRESET)
 * - timeout_degrade: Retry with reduced max_tokens (for timeout errors)
 * - strip_media_retry: Remove large media from messages and retry (for media_too_large)
 * - overloaded_backoff: Exponential backoff starting at 5s, max 120s (for model_overloaded/503)
 * - inject_tool_hint_retry: Inject correction hint for tool schema errors (for invalid_tool_use)
 * - content_policy_reject: No retry; notify user about content policy rejection
 * - partial_continue: Send "continue" to resume incomplete response (for partial_response)
 * - server_error_backoff: Exponential backoff with diagnostics (for server_error/500)
 * - unknown_single_retry: Single retry attempt then give up (for unknown errors)
 * - model_fallback: Switch to fallback model after retries exhausted (for model_overloaded/timeout)
 * - none: Do not retry (for auth errors or exhausted retries)
 */
export function mapErrorToRecoveryAction(kind: ApiErrorKind, retryAttempt: number): RecoveryAction {
	switch (kind) {
		case "prompt_too_long":
			return retryAttempt < 3 ? "reactive_compact_then_retry" : "none"
		case "max_output_tokens":
			return retryAttempt < 3 ? "retry_with_continuation" : "none"
		case "context_window_exceeded":
			return retryAttempt < 2 ? "context_window_recover" : "none"
		case "rate_limit":
			return retryAttempt < 10 ? "backoff_retry" : "none"
		case "capacity":
			// 529 capacity errors: shorter backoff, fewer retries than rate limits
			return retryAttempt < 5 ? "backoff_retry" : "none"
		case "server_error":
			// 500 server errors: exponential backoff with diagnostics, up to 5 retries
			return retryAttempt < 5 ? "server_error_backoff" : "none"
		case "network_error":
			return retryAttempt < 5 ? "backoff_retry" : "none"
		case "stale_connection":
			// ECONNRESET/EPIPE: safe to retry immediately, connection just dropped
			return retryAttempt < 3 ? "immediate_retry" : "none"
		case "timeout":
			// Timeout: 1st immediate, 2nd reduce max_tokens to 60%, 3rd trigger model fallback
			if (retryAttempt < 3) return "timeout_degrade"
			return "model_fallback"
		case "auth_error":
			return "none" // Auth errors should not be retried; notify user

		// === New error categories (Task 4.2) ===

		case "media_too_large":
			// Detect large media → strip/compress → retry, max 2 attempts
			return retryAttempt < 2 ? "strip_media_retry" : "none"

		case "model_overloaded":
			// 503 overload: exponential backoff (5s start, 120s max), 3 retries
			// After 3 failures, trigger model fallback
			if (retryAttempt < 3) return "overloaded_backoff"
			return "model_fallback"

		case "invalid_tool_use":
			// Inject correction hint, max 3 retries; 2nd retry adds tool example
			return retryAttempt < 3 ? "inject_tool_hint_retry" : "none"

		case "content_policy":
			// Never retry; notify user about content rejection
			return "content_policy_reject"

		case "partial_response":
			// Keep existing content, send "continue", max 3 continuations
			return retryAttempt < 3 ? "partial_continue" : "none"

		case "unknown":
			// Log full error, try once, then give up
			return retryAttempt < 1 ? "unknown_single_retry" : "none"

		default:
			return "none"
	}
}

/**
 * Query source classification for differentiated retry behavior.
 * Foreground queries (user-initiated) get more aggressive retry.
 * Background queries (auto-compact, sub-tasks) use conservative retry
 * to avoid cascade amplification.
 */
export type QuerySource = "user_query" | "sub_task" | "auto_compact" | "tool_execution"

const FOREGROUND_SOURCES = new Set<QuerySource>(["user_query", "sub_task", "tool_execution"])

/**
 * Determines if a capacity (529) error should be retried based on query source.
 * Background queries (like auto_compact) should not retry capacity errors
 * to prevent cascade amplification during service degradation.
 */
export function shouldRetryCapacityError(source: QuerySource): boolean {
	return FOREGROUND_SOURCES.has(source)
}
