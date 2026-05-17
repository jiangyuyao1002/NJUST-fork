export type ApiErrorKind =
	| "prompt_too_long"
	| "max_output_tokens"
	| "context_window_exceeded"
	| "rate_limit"
	| "auth_error"
	| "model_unavailable"
	| "capacity"
	| "server_error"
	| "network_error"
	| "stale_connection"
	| "timeout"
	// === New error categories (Task 4.2) ===
	| "media_too_large"   // Media file exceeds size limit
	| "model_overloaded"  // Model overloaded (503 with overload signal)
	| "invalid_tool_use"  // Tool call format/schema error
	| "content_policy"    // Content rejected by safety/policy filter
	| "partial_response"  // Incomplete response (stop_reason=max_tokens)
	| "unknown"

type ApiErrorLike = {
	message?: unknown
	status?: unknown
	code?: unknown
	stop_reason?: unknown
	stopReason?: unknown
}

function asApiErrorLike(error: unknown): ApiErrorLike {
	return error !== null && typeof error === "object" ? (error as ApiErrorLike) : {}
}

/**
 * Classifies an API error into a specific error kind for recovery routing.
 *
 * Classification priority (highest → lowest):
 * 1. Content/format errors (prompt_too_long, media_too_large, content_policy, invalid_tool_use)
 * 2. Token/context limits (max_output_tokens, context_window_exceeded, partial_response)
 * 3. Auth errors (auth_error)
 * 4. Rate/capacity (rate_limit, capacity)
 * 5. Model availability (model_overloaded, model_unavailable)
 * 6. Server errors (server_error)
 * 7. Connection errors (stale_connection, timeout, network_error)
 * 8. Fallback (unknown)
 */
export function classifyApiError(error: unknown): ApiErrorKind {
	const e = asApiErrorLike(error)
	const msg = String(e?.message ?? "").toLowerCase()
	const status = Number(e?.status ?? 0)
	const code = String(e?.code ?? "").toLowerCase()
	const stopReason = String(e?.stop_reason ?? e?.stopReason ?? "").toLowerCase()

	// ── 1. Content / format errors (most specific first) ────────────────

	// Media file too large: explicit size-related rejection
	if (/too large|size exceeds|payload too large|file.*too.*big|media.*limit/.test(msg) || status === 413)
		return "media_too_large"

	// Content policy violation: safety filter rejection
	if (/content policy|content_policy|safety|content filter|moderation|flagged|blocked by policy/.test(msg))
		return "content_policy"

	// Invalid tool use: schema validation or format error in tool calls
	if (/tool_use|invalid tool|tool.*schema|tool.*format|tool call|invalid_tool/.test(msg))
		return "invalid_tool_use"

	if (/prompt.*too.*long|input.*too.*long|request.*too.*large/.test(msg)) return "prompt_too_long"

	// ── 2. Token / context limits ───────────────────────────────────────

	if (/max[_\s-]?tokens|max[_\s-]?output[_\s-]?tokens|output token limit/.test(msg)) return "max_output_tokens"
	if (/context window|context length|token limit exceeded/.test(msg)) return "context_window_exceeded"

	// Partial response: model stopped at max_tokens but content is incomplete
	if (stopReason === "max_tokens" || stopReason === "length") return "partial_response"

	// ── 3. Auth errors ──────────────────────────────────────────────────

	if (status === 429 || /rate limit|too many requests/.test(msg)) return "rate_limit"
	if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*api.*key|authentication/.test(msg))
		return "auth_error"

	// ── 4. Rate / capacity ─────────────────────────────────────────────

	// 529 capacity errors: provider-specific overload
	if (status === 529 || /capacity/.test(msg)) return "capacity"

	// ── 5. Model availability ──────────────────────────────────────────

	// 503 with overloaded signal → model_overloaded (distinct from generic 503)
	if (status === 503 || /overloaded|model.*unavailable|service.*unavailable/.test(msg)) return "model_overloaded"

	// ── 6. Server errors ───────────────────────────────────────────────

	if (status >= 500) return "server_error"

	// ── 7. Connection errors ───────────────────────────────────────────

	// Stale connection errors (ECONNRESET/EPIPE) can be retried immediately
	if (/econnreset|epipe|socket hang up/.test(msg)) return "stale_connection"
	// Timeout: ETIMEDOUT, ESOCKETTIMEDOUT, or generic timeout
	if (/etimedout|esockettimedout/.test(msg) || /etimedout|esockettimedout/.test(code) || /timeout/.test(msg))
		return "timeout"
	if (/network|econn|fetch failed|enotfound|econnrefused/.test(msg)) return "network_error"

	// ── 8. Fallback ────────────────────────────────────────────────────

	return "unknown"
}
