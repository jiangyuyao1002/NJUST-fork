import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@njust-ai-cj/types"

import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../index"

import { ApiStream } from "../transform/stream"
import { countTokensDetailed, type TokenCountResult } from "../../utils/countTokens"
import { isMcpTool } from "../../utils/mcp-name"
import { computeBackoffMs, delayMs, DEFAULT_API_RETRY_OPTIONS, type ApiRetryOptions } from "../retry/ApiRetryStrategy"
import { analyzeErrorForRetry } from "../retry/ApiErrorClassifier"
import { taskEventBus } from "../../core/events/TaskEventBus"

/**
 * Base class for API providers that implements common functionality.
 */
export abstract class BaseProvider implements ApiHandler {
	abstract createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream

	abstract getModel(): { id: string; info: ModelInfo }

	/**
	 * Whether this provider supports OpenAI strict mode for tool schemas.
	 * Override and return false for non-OpenAI providers that reject strict mode.
	 */
	protected shouldUseStrictMode(): boolean {
		return true
	}

	/**
	 * Converts an array of tools to be compatible with OpenAI's strict mode.
	 * Filters for function tools, applies schema conversion to their parameters,
	 * and ensures all tools have consistent strict values.
	 */
	protected convertToolsForOpenAI(tools: any[] | undefined): any[] | undefined {
		if (!tools) {
			return undefined
		}

		const useStrict = this.shouldUseStrictMode()

		return tools.map((tool) => {
			if (tool.type !== "function") {
				return tool
			}

			// MCP tools use the 'mcp--' prefix - disable strict mode for them
			// to preserve optional parameters from the MCP server schema
			const isMcp = isMcpTool(tool.function.name)

			return {
				...tool,
				function: {
					...tool.function,
					strict: useStrict && !isMcp,
					parameters: useStrict && !isMcp
						? this.convertToolSchemaForOpenAI(tool.function.parameters)
						: tool.function.parameters,
				},
			}
		})
	}

	/**
	 * Converts tool schemas to be compatible with OpenAI's strict mode by:
	 * - Ensuring all properties are in the required array (strict mode requirement)
	 * - Preserving original optional semantics by allowing null for properties that were
	 *   not in the original required array
	 * - Adding additionalProperties: false to all object schemas (required by OpenAI Responses API)
	 * - Recursively processing nested objects and arrays
	 */
	protected convertToolSchemaForOpenAI(schema: any): any {
		const getPrimaryType = (value: any): string | undefined =>
			Array.isArray(value?.type) ? value.type.find((t: string) => t !== "null") : value?.type

		if (!schema || typeof schema !== "object" || getPrimaryType(schema) !== "object") {
			return schema
		}

		const result = { ...schema }
		const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : [])

		// OpenAI Responses API requires additionalProperties: false on all object schemas
		// Only add if not already set to false (to avoid unnecessary mutations)
		if (result.additionalProperties !== false) {
			result.additionalProperties = false
		}

		if (result.properties) {
			const allKeys = Object.keys(result.properties)
			// OpenAI strict mode requires ALL properties to be in required array
			result.required = allKeys

			// Recursively process nested objects and convert nullable types
			const newProps = { ...result.properties }
			for (const key of allKeys) {
				const prop = newProps[key]

				if (prop && !originallyRequired.has(key)) {
					const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []
					if (types.length > 0 && !types.includes("null")) {
						newProps[key] = { ...prop, type: [...types, "null"] }
					}
				}

				const normalizedProp = newProps[key]
				const primaryType = getPrimaryType(normalizedProp)
				// Recursively process nested objects
				if (normalizedProp && primaryType === "object") {
					newProps[key] = this.convertToolSchemaForOpenAI(normalizedProp)
				} else if (normalizedProp && primaryType === "array" && getPrimaryType(normalizedProp.items) === "object") {
					newProps[key] = {
						...normalizedProp,
						items: this.convertToolSchemaForOpenAI(normalizedProp.items),
					}
				}
			}
			result.properties = newProps
		}

		return result
	}

	protected hasNativeTokenCounting(): boolean {
		return false
	}

	/**
	 * Override when {@link hasNativeTokenCounting} is true; return undefined to fall back to tiktoken.
	 */
	protected async countTokensNative(
		_content: Anthropic.Messages.ContentBlockParam[],
	): Promise<number | TokenCountResult | undefined> {
		return undefined
	}

	/**
	 * Default token counting using tiktoken; providers may override {@link hasNativeTokenCounting}.
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		const result = await this.countTokensDetailed(content)
		return result.total
	}

	async countTokensDetailed(content: Anthropic.Messages.ContentBlockParam[]): Promise<TokenCountResult> {
		if (content.length === 0) {
			return { total: 0, strategy: "tiktoken" }
		}

		if (this.hasNativeTokenCounting()) {
			const native = await this.countTokensNative(content)
			if (native !== undefined) {
				if (typeof native === "number") {
					return { total: native, strategy: "native" }
				}
				return native
			}
		}

		return countTokensDetailed(content, { useWorker: true })
	}

	/**
	 * Wraps an async operation with exponential backoff retry.
	 * Retries network errors, 429 (honoring Retry-After), and 5xx.
	 * Does NOT retry 4xx client errors or auth failures.
	 */
	protected async withRetry<T>(
		operation: () => Promise<T>,
		retryConfig?: Partial<ApiRetryOptions>,
		context?: { taskId?: string; provider?: string },
	): Promise<T> {
		const config = { ...DEFAULT_API_RETRY_OPTIONS, ...retryConfig }
		let lastError: unknown

		for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
			try {
				return await operation()
			} catch (error) {
				lastError = error
				const decision = analyzeErrorForRetry(error)
				if (!decision.shouldRetry || attempt >= config.maxAttempts - 1) {
					throw error
				}
				const delay = computeBackoffMs(attempt, config, decision.retryAfterSeconds)
				taskEventBus.emit("task:llm-retry", {
					taskId: context?.taskId,
					data: {
						attempt: attempt + 1,
						delayMs: delay,
						category: decision.category,
						provider: context?.provider ?? this.constructor.name,
					},
				})
				await delayMs(delay)
			}
		}

		throw lastError
	}
}
