import { NamedError } from "./NamedError.js"

/**
 * ApiProviderError
 *
 * Used by API providers (OpenAI, Anthropic, Gemini, Bedrock, etc.) when wrapping
 * raw API errors. Preserves metadata (status, errorDetails, code) for retry logic
 * and UI display. Tests use instanceof ApiProviderError to verify error handling.
 */
export class ApiProviderError extends NamedError {
	status?: number
	errorDetails?: unknown
	code?: string
	$metadata?: unknown
	provider?: string
	modelId?: string
	operation?: string

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
	}
}

/**
 * ConsecutiveMistakeError
 *
 * Thrown when the model makes too many consecutive mistakes (e.g., invalid tool
 * calls). TelemetryService.captureConsecutiveMistakeError captures these for
 * analytics. PresentAssistantMessage and related code may check for this type.
 */
export class ConsecutiveMistakeError extends NamedError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
	}
}
