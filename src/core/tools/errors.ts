/**
 * Structured error hierarchy for tool execution.
 *
 * Replaces the standalone `isRetryableToolError()` function with a proper class hierarchy.
 * Each error type carries a `telemetrySafe` message that strips sensitive information.
 *
 * Inspired by Claude Code's classifyToolError() pattern.
 */

import { NamedError } from "@njust-ai/core/shared"

/**
 * Base error class for all tool-related errors.
 */
export class ToolError extends NamedError {
	constructor(
		public readonly toolName: string,
		message: string,
		/** A sanitized version of the message safe for telemetry/logging (no secrets, paths, etc.) */
		public readonly telemetrySafe?: string,
	) {
		super(message)
	}
}

/**
 * Error thrown when tool input validation fails (Zod schema or business logic).
 */
export class ValidationError extends ToolError {
	constructor(toolName: string, message: string, telemetrySafe?: string) {
		super(toolName, message, telemetrySafe ?? `Validation failed for tool '${toolName}'`)
	}
}

/**
 * Error thrown when tool execution is denied by the permission system.
 */
export class PermissionError extends ToolError {
	constructor(toolName: string, message?: string) {
		super(toolName, message ?? `Permission denied for tool '${toolName}'`, `Permission denied: ${toolName}`)
	}
}

/**
 * Error for transient failures that may succeed on retry.
 * Replaces the standalone `isRetryableToolError()` helper.
 */
export class RetryableError extends ToolError {
	constructor(
		toolName: string,
		message: string,
		public readonly originalError?: Error,
	) {
		super(toolName, message, `Retryable error in tool '${toolName}'`)
	}

	/**
	 * Classify whether an arbitrary error is retryable.
	 * Matches HTTP status codes, network error codes, and common transient error messages.
	 */
	static isRetryable(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false
		}
		const anyErr = error as Error & { code?: string; status?: number; cause?: unknown }
		const message = (error.message || "").toLowerCase()

		// HTTP status codes indicating transient failures
		if (anyErr.status && [408, 409, 425, 429, 500, 502, 503, 504].includes(anyErr.status)) {
			return true
		}
		// Network error codes
		if (
			anyErr.code &&
			["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(anyErr.code)
		) {
			return true
		}
		// Message-based detection
		if (
			message.includes("timeout") ||
			message.includes("timed out") ||
			message.includes("rate limit") ||
			message.includes("429") ||
			message.includes("temporar") ||
			message.includes("fetch failed")
		) {
			return true
		}
		// Check cause chain
		const cause = anyErr.cause as { code?: string; message?: string } | undefined
		if (cause?.code && ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(cause.code)) {
			return true
		}
		return false
	}
}

/**
 * Error thrown when tool execution is aborted (user cancellation, sibling abort, etc.)
 */
export class AbortError extends ToolError {
	constructor(toolName: string, message?: string) {
		super(toolName, message ?? `Tool '${toolName}' was aborted`, `Aborted: ${toolName}`)
	}
}
