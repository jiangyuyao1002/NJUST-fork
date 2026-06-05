export type ApiErrorKind =
	| "prompt_too_long"
	| "max_output_tokens"
	| "context_window_exceeded"
	| "rate_limit"
	| "auth_error"
	| "capacity"
	| "server_error"
	| "network_error"
	| "stale_connection"
	| "timeout"
	| "media_too_large"
	| "model_overloaded"
	| "invalid_tool_use"
	| "content_policy"
	| "partial_response"
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

export function classifyApiError(error: unknown): ApiErrorKind {
	const e = asApiErrorLike(error)
	const msg = String(e.message ?? "").toLowerCase()
	const status = Number(e.status ?? 0)
	const code = String(e.code ?? "").toLowerCase()
	const stopReason = String(e.stop_reason ?? e.stopReason ?? "").toLowerCase()

	if (/too large|size exceeds|payload too large|file.*too.*big|media.*limit/.test(msg) || status === 413) {
		return "media_too_large"
	}
	if (/content policy|content_policy|safety|content filter|moderation|flagged|blocked by policy/.test(msg)) {
		return "content_policy"
	}
	if (/tool_use|invalid tool|tool.*schema|tool.*format|tool call|invalid_tool/.test(msg)) {
		return "invalid_tool_use"
	}
	if (/prompt.*too.*long|input.*too.*long|request.*too.*large/.test(msg)) {
		return "prompt_too_long"
	}

	if (/max[_\s-]?tokens|max[_\s-]?output[_\s-]?tokens|output token limit/.test(msg)) {
		return "max_output_tokens"
	}
	if (/context window|context length|token limit exceeded/.test(msg)) {
		return "context_window_exceeded"
	}
	if (stopReason === "max_tokens" || stopReason === "length") {
		return "partial_response"
	}

	if (status === 429 || /rate limit|too many requests/.test(msg)) {
		return "rate_limit"
	}
	if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.*api.*key|authentication/.test(msg)) {
		return "auth_error"
	}

	if (status === 529 || /capacity/.test(msg)) {
		return "capacity"
	}
	if (status === 503 || /overloaded|model.*unavailable|service.*unavailable/.test(msg)) {
		return "model_overloaded"
	}
	if (status >= 500) {
		return "server_error"
	}

	if (/econnreset|epipe|socket hang up/.test(msg)) {
		return "stale_connection"
	}
	if (/etimedout|esockettimedout/.test(msg) || /etimedout|esockettimedout/.test(code) || /timeout/.test(msg)) {
		return "timeout"
	}
	if (/network|econn|fetch failed|enotfound|econnrefused/.test(msg)) {
		return "network_error"
	}

	return "unknown"
}
