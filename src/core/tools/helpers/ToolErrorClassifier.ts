/**
 * ToolErrorClassifier — systematic classification of tool execution errors.
 *
 * Provides structured error categorization for:
 *   - Retry decisions
 *   - User-facing error messages
 *   - Telemetry/diagnostics
 *   - Recovery strategy selection
 *
 * Integrates with (but does not replace) the existing RetryableError system.
 */

/**
 * Structured classification of a tool error.
 */
export interface ToolErrorClassification {
	/** High-level error category. */
	category: ToolErrorCategory
	/** Whether this error is retryable. */
	retryable: boolean
	/** Whether the error is safe to include in telemetry (no PII). */
	telemetrySafe: boolean
	/** Sanitized error message for logging. */
	sanitizedMessage: string
	/** Optional suggested user-facing message. */
	userMessage?: string
	/** Optional error code for programmatic handling. */
	code?: string
}

export type ToolErrorCategory =
	| "filesystem" // ENOENT, EACCES, EPERM, ENOSPC, EISDIR, etc.
	| "network" // ECONNREFUSED, ETIMEDOUT, ECONNRESET, DNS failures
	| "permission" // Permission denied by the security system
	| "timeout" // Operation timed out
	| "validation" // Invalid input parameters
	| "not_found" // Resource not found (file, tool, MCP server)
	| "conflict" // Resource conflict (file locked, merge conflict)
	| "quota" // Rate limit, token budget, disk quota
	| "external" // External service error (MCP server, API)
	| "internal" // Internal/unexpected error
	| "unknown" // Cannot classify

/**
 * Classify a tool execution error into a structured category.
 *
 * This function examines the error's message, code, and status to determine
 * the most specific category. It is designed to be used alongside
 * RetryableError.isRetryable() — not as a replacement.
 */
export function classifyToolError(error: UnsafeAny): ToolErrorClassification {
	const e = error as UnsafeAny
	const msg = String(e?.message ?? "").toLowerCase()
	const code = String(e?.code ?? "")
	const _errno = String(e?.errno ?? "")

	// ── Filesystem errors ────────────────────────────────────────────
	if (code === "ENOENT" || /no such file|file not found|enoent/i.test(msg)) {
		return {
			category: "filesystem",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "File or directory not found",
			userMessage: "The specified file or directory does not exist.",
			code: "ENOENT",
		}
	}
	const isToolPermission = /permission denied for tool|blocked by hook|permission.*deny/i.test(msg)
	if (
		!isToolPermission &&
		(code === "EACCES" || code === "EPERM" || /permission denied|access denied|eacces|eperm/i.test(msg))
	) {
		return {
			category: "filesystem",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "File system permission denied",
			userMessage: "Insufficient permissions to access this file or directory.",
			code: code || "EACCES",
		}
	}
	if (code === "ENOSPC" || /no space|disk full|enospc/i.test(msg)) {
		return {
			category: "filesystem",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "No disk space remaining",
			userMessage: "The disk is full. Free up space and try again.",
			code: "ENOSPC",
		}
	}
	if (code === "EISDIR" || /is a directory/i.test(msg)) {
		return {
			category: "filesystem",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "Path is a directory, expected a file",
			code: "EISDIR",
		}
	}

	// ── Network errors ───────────────────────────────────────────────
	if (/econnrefused|connection refused/i.test(msg) || code === "ECONNREFUSED") {
		return {
			category: "network",
			retryable: true,
			telemetrySafe: true,
			sanitizedMessage: "Connection refused",
			userMessage: "Unable to connect to the remote service.",
			code: "ECONNREFUSED",
		}
	}
	if (/etimedout|esockettimedout|timed?\s?out/i.test(msg) || code === "ETIMEDOUT") {
		return {
			category: "timeout",
			retryable: true,
			telemetrySafe: true,
			sanitizedMessage: "Connection timed out",
			userMessage: "The operation timed out. Try again.",
			code: "ETIMEDOUT",
		}
	}
	if (/econnreset|socket hang up|epipe/i.test(msg)) {
		return {
			category: "network",
			retryable: true,
			telemetrySafe: true,
			sanitizedMessage: "Connection reset",
			code: code || "ECONNRESET",
		}
	}
	if (/enotfound|dns|getaddrinfo/i.test(msg)) {
		return {
			category: "network",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "DNS resolution failed",
			userMessage: "Could not resolve the hostname.",
			code: "ENOTFOUND",
		}
	}

	// ── Permission errors ────────────────────────────────────────────
	if (/permission denied for tool|blocked by hook|permission.*deny/i.test(msg)) {
		return {
			category: "permission",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "Tool permission denied",
		}
	}

	// ── Validation errors ────────────────────────────────────────────
	if (/invalid.*input|validation.*fail|schema.*error|missing.*param/i.test(msg)) {
		return {
			category: "validation",
			retryable: false,
			telemetrySafe: true,
			sanitizedMessage: "Input validation failed",
		}
	}

	// ── Rate/quota errors ────────────────────────────────────────────
	if (/rate.?limit|too many requests|429|quota.*exceeded/i.test(msg)) {
		return {
			category: "quota",
			retryable: true,
			telemetrySafe: true,
			sanitizedMessage: "Rate limit or quota exceeded",
			userMessage: "Too many requests. Please wait and try again.",
		}
	}

	// ── Unknown ──────────────────────────────────────────────────────
	return {
		category: "unknown",
		retryable: false,
		telemetrySafe: false,
		sanitizedMessage: "Unexpected error",
	}
}
