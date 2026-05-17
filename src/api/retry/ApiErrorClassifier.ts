import { redactApiSecrets } from "../../utils/redactApiSecrets"
import { classifyApiError, type ApiErrorKind } from "../../core/errors/apiErrorClassifier"

/**
 * Retry / error taxonomy for API calls (report D.2).
 */
export enum ApiErrorCategory {
	RetryableNetwork = "retryable_network",
	RateLimited = "rate_limited",
	ServerError = "server_error",
	ClientError = "client_error",
	Unknown = "unknown",
}

export function classifyHttpStatus(status: number | undefined): ApiErrorCategory {
	if (status === undefined) {
		return ApiErrorCategory.Unknown
	}
	if (status === 429) {
		return ApiErrorCategory.RateLimited
	}
	if (status >= 500) {
		return ApiErrorCategory.ServerError
	}
	if (status >= 400) {
		return ApiErrorCategory.ClientError
	}
	return ApiErrorCategory.Unknown
}

/**
 * Best-effort Retry-After (seconds) from OpenAI-style errors or Response headers.
 */
export function getRetryAfterSecondsFromError(error: unknown): number | undefined {
	const e = asRetryErrorLike(error)
	if (typeof e?.retryAfter === "number" && Number.isFinite(e.retryAfter)) {
		return e.retryAfter
	}
	const raw =
		e?.headers?.get?.("retry-after") ??
		(e?.response?.headers && typeof e.response.headers.get === "function"
			? e.response.headers.get("retry-after")
			: undefined)
	if (raw == null || raw === "") {
		return undefined
	}
	const n = Number(raw)
	if (Number.isFinite(n)) {
		return n
	}
	const retryDate = Date.parse(raw)
	if (!Number.isNaN(retryDate)) {
		// Enforce minimum 1s delay to prevent retry storms from clock skew
		return Math.max(1, (retryDate - Date.now()) / 1000)
	}
	return undefined
}

type RetryErrorLike = {
	status?: unknown
	response?: { status?: unknown; headers?: Headers }
	headers?: { get?: (name: string) => string | null }
	retryAfter?: unknown
}

function asRetryErrorLike(error: unknown): RetryErrorLike {
	return error !== null && typeof error === "object" ? (error as RetryErrorLike) : {}
}

function getStatusFromError(error: unknown): number | undefined {
	const e = asRetryErrorLike(error)
	const status = typeof e.status === "number" ? e.status : e.response?.status
	return typeof status === "number" && Number.isFinite(status) ? status : undefined
}

function categoryForApiErrorKind(kind: ApiErrorKind): ApiErrorCategory {
	switch (kind) {
		case "rate_limit":
			return ApiErrorCategory.RateLimited
		case "server_error":
		case "capacity":
		case "model_overloaded":
		case "model_unavailable":
			return ApiErrorCategory.ServerError
		case "network_error":
		case "stale_connection":
		case "timeout":
			return ApiErrorCategory.RetryableNetwork
		case "prompt_too_long":
		case "max_output_tokens":
		case "context_window_exceeded":
		case "auth_error":
		case "media_too_large":
		case "invalid_tool_use":
		case "content_policy":
		case "partial_response":
			return ApiErrorCategory.ClientError
		case "unknown":
			return ApiErrorCategory.Unknown
	}
}

function shouldRetryCategory(category: ApiErrorCategory): boolean {
	return (
		category === ApiErrorCategory.RetryableNetwork ||
		category === ApiErrorCategory.RateLimited ||
		category === ApiErrorCategory.ServerError
	)
}

export type ApiRetryDecision = {
	/** Whether a safe automatic retry may be attempted for this failure */
	shouldRetry: boolean
	category: ApiErrorCategory
	/** Optional delay hint in seconds (429, Retry-After) */
	retryAfterSeconds?: number
}

/**
 * Policy for wrapping `createMessage` / stream start: never retry clear auth failures;
 * retry rate limits (honour Retry-After), 5xx, and unknown/network faults.
 */
export function analyzeErrorForRetry(error: unknown): ApiRetryDecision {
	const status = getStatusFromError(error)

	const statusCategory = classifyHttpStatus(status)
	if (statusCategory === ApiErrorCategory.RateLimited) {
		return {
			shouldRetry: true,
			category: ApiErrorCategory.RateLimited,
			retryAfterSeconds: getRetryAfterSecondsFromError(error),
		}
	}
	if (statusCategory !== ApiErrorCategory.Unknown) {
		return {
			shouldRetry: shouldRetryCategory(statusCategory),
			category: statusCategory,
		}
	}

	const category = categoryForApiErrorKind(classifyApiError(error))
	if (status === undefined) {
		if (category === ApiErrorCategory.Unknown) {
			return { shouldRetry: true, category: ApiErrorCategory.RetryableNetwork }
		}
		return { shouldRetry: shouldRetryCategory(category), category }
	}
	return { shouldRetry: shouldRetryCategory(category), category }
}

/** Safe one-line representation of an error for logs/metrics (strips bearer / sk- style secrets). */
export function redactErrorForTelemetry(error: unknown): string {
	if (error instanceof Error) {
		return redactApiSecrets(`${error.name}: ${error.message}`)
	}
	return redactApiSecrets(String(error))
}
