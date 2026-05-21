import * as os from "os"
import { Anthropic } from "@anthropic-ai/sdk"

import { Package } from "../../../shared/package"
import { ApiProviderError, type VerbosityLevel, type ReasoningEffortExtended, type ServiceTier } from "@njust-ai-cj/types"
import { OPENAI_NATIVE_DEFAULT_TEMPERATURE } from "@njust-ai-cj/core/providers"
import { TelemetryService } from "@njust-ai-cj/telemetry"

import { sanitizeOpenAiCallId } from "../../../utils/tool-id"
import { getErrorMessage } from "../../../shared/error-utils"

import { ApiStream } from "../../transform/stream"
import type { ApiHandlerCreateMessageMetadata } from "../../types"
import { requireApiKey } from "../../interfaces/api-key-validator"

import {
	type OpenAiNativeModel,
	type ResponsesInputItem,
	type ResponsesRequestBody,
	type ResponsesClientLike,
	openAiErrorResponseSchema,
} from "./base"
import { convertToolsForResponsesApi } from "./tools"
import { dispatchEvent, type EventHandlerContext } from "./event-handlers"
import { parseSseStream, type SseParserContext } from "./sse-parser"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ResponsesApiMixin<T extends abstract new (...args: any[]) => any>(Base: T) {
	abstract class ResponsesApiImpl extends Base {
		async *createMessage(
			systemPrompt: string,
			messages: Anthropic.Messages.MessageParam[],
			metadata?: ApiHandlerCreateMessageMetadata,
		): ApiStream {
			const model = this.getModel()
			yield* this.handleResponsesApiMessage(model, systemPrompt, messages, metadata)
		}

		private async *handleResponsesApiMessage(
			model: OpenAiNativeModel,
			systemPrompt: string,
			messages: Anthropic.Messages.MessageParam[],
			metadata?: ApiHandlerCreateMessageMetadata,
		): ApiStream {
			this.lastServiceTier = undefined
			this.lastResponseOutput = undefined
			this.lastResponseId = undefined
			this.pendingToolCallId = undefined
			this.pendingToolCallName = undefined
			this.sawTextOutputInCurrentResponse = false
			this.sawTextDeltaInCurrentResponse = false
			this.streamedToolCallIds.clear()

			const { verbosity } = this.getModel()
			const reasoningEffort = this.getReasoningEffort(model)
			const formattedInput = this.formatFullConversation(systemPrompt, messages)
			const requestBody = this.buildRequestBody(
				model,
				formattedInput,
				systemPrompt,
				verbosity,
				reasoningEffort,
				metadata,
			)
			yield* this.executeRequest(requestBody, model, metadata, systemPrompt, messages)
		}

		private buildRequestBody(
			model: OpenAiNativeModel,
			formattedInput: ResponsesInputItem[],
			systemPrompt: string,
			verbosity: VerbosityLevel | undefined,
			reasoningEffort: ReasoningEffortExtended | undefined,
			metadata?: ApiHandlerCreateMessageMetadata,
		): ResponsesRequestBody {
			const requestedTier = (this.options.openAiNativeServiceTier as ServiceTier | undefined) || undefined
			const allowedTierNames = new Set(model.info.tiers?.map((t) => t.name).filter(Boolean) || [])
			const promptCacheRetention = this.getPromptCacheRetention(model)

			const body: ResponsesRequestBody = {
				model: model.id,
				input: formattedInput,
				stream: true,
				store: false,
				instructions: systemPrompt,
				...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
				...(reasoningEffort
					? {
							reasoning: {
								...(reasoningEffort ? { effort: reasoningEffort } : {}),
								...(this.options.enableResponsesReasoningSummary ? { summary: "auto" as const } : {}),
							},
						}
					: {}),
				...(model.info.supportsTemperature !== false && {
					temperature: this.options.modelTemperature ?? OPENAI_NATIVE_DEFAULT_TEMPERATURE,
				}),
				...(model.maxTokens ? { max_output_tokens: model.maxTokens } : {}),
				...(requestedTier &&
					(requestedTier === "default" || allowedTierNames.has(requestedTier)) && {
						service_tier: requestedTier,
					}),
				...(promptCacheRetention ? { prompt_cache_retention: promptCacheRetention } : {}),
				tools: convertToolsForResponsesApi(metadata?.tools ?? []),
				tool_choice: metadata?.tool_choice,
				parallel_tool_calls: metadata?.parallelToolCalls ?? false,
			}

			if (model.info.supportsVerbosity === true) {
				body.text = { verbosity: (verbosity || "medium") as VerbosityLevel }
			}

			return body
		}

		private async *executeRequest(
			requestBody: ResponsesRequestBody,
			model: OpenAiNativeModel,
			metadata?: ApiHandlerCreateMessageMetadata,
			systemPrompt?: string,
			messages?: Anthropic.Messages.MessageParam[],
		): ApiStream {
			this.abortController = new AbortController()
			const taskId = metadata?.taskId
			const userAgent = `roo-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`
			const requestHeaders: Record<string, string> = {
				originator: "roo-code",
				session_id: taskId || this.sessionId,
				"User-Agent": userAgent,
			}

			try {
				const stream = await (this.client as UnsafeAny as ResponsesClientLike).responses.create(requestBody, {
					signal: this.abortController.signal,
					headers: requestHeaders,
				})

				if (typeof stream[Symbol.asyncIterator] !== "function") {
					throw new ApiProviderError(
						"OpenAI SDK did not return an AsyncIterable for Responses API streaming. Falling back to SSE.",
					)
				}

				for await (const event of stream) {
					if (this.abortController.signal.aborted) {
						break
					}
					for await (const outChunk of dispatchEvent(event, model, this as unknown as EventHandlerContext)) {
						yield outChunk
					}
				}
			} catch (sdkErr: UnsafeAny) {
				const err = sdkErr as Record<string, UnsafeAny>
				const errMessage = getErrorMessage(sdkErr)
				const errCode = err.code as string | undefined
				const errStatus = err.status as number | undefined
				const isConnectionError =
					errCode === "ECONNREFUSED" ||
					errCode === "ECONNRESET" ||
					errCode === "ETIMEDOUT" ||
					errCode === "ENOTFOUND" ||
					(err.name as string) === "NetworkError" ||
					errMessage?.includes("network") ||
					errMessage?.includes("ECONN") ||
					errMessage?.includes("stream")

				const isStreamError =
					errStatus === 502 || errStatus === 503 || errStatus === 504 || errMessage?.includes("stream")

				if (isConnectionError || isStreamError) {
					yield* this.makeResponsesApiRequest(requestBody, model, metadata, systemPrompt, messages)
				} else {
					throw sdkErr
				}
			} finally {
				this.abortController = undefined
			}
		}

		private formatFullConversation(
			systemPrompt: string,
			messages: Anthropic.Messages.MessageParam[],
		): ResponsesInputItem[] {
			const formattedInput: ResponsesInputItem[] = []

			for (const message of messages) {
				if ((message as Record<string, UnsafeAny>).type === "reasoning") {
					formattedInput.push(message)
					continue
				}

				if (message.role === "user") {
					const content: Record<string, UnsafeAny>[] = []
					const toolResults: ResponsesInputItem[] = []

					if (typeof message.content === "string") {
						content.push({ type: "input_text", text: message.content })
					} else if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "text") {
								content.push({ type: "input_text", text: block.text })
							} else if (block.type === "image") {
								const image = block as Anthropic.Messages.ImageBlockParam
								const imageUrl = `data:${image.source.media_type};base64,${image.source.data}`
								content.push({ type: "input_image", image_url: imageUrl })
							} else if (block.type === "tool_result") {
								const result =
									typeof block.content === "string"
										? block.content
										: block.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || ""
								toolResults.push({
									type: "function_call_output",
									call_id: sanitizeOpenAiCallId(block.tool_use_id),
									output: result,
								})
							}
						}
					}

					if (content.length > 0) {
						formattedInput.push({ role: "user", content })
					}
					if (toolResults.length > 0) {
						formattedInput.push(...toolResults)
					}
				} else if (message.role === "assistant") {
					const content: Record<string, UnsafeAny>[] = []
					const toolCalls: ResponsesInputItem[] = []

					if (typeof message.content === "string") {
						content.push({ type: "output_text", text: message.content })
					} else if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "text") {
								content.push({ type: "output_text", text: block.text })
							} else if (block.type === "tool_use") {
								toolCalls.push({
									type: "function_call",
									call_id: sanitizeOpenAiCallId(block.id),
									name: block.name,
									arguments: JSON.stringify(block.input),
								})
							}
						}
					}

					if (content.length > 0) {
						formattedInput.push({ role: "assistant", content })
					}
					if (toolCalls.length > 0) {
						formattedInput.push(...toolCalls)
					}
				}
			}

			return formattedInput
		}

		private async *makeResponsesApiRequest(
			requestBody: ResponsesRequestBody,
			model: OpenAiNativeModel,
			metadata?: ApiHandlerCreateMessageMetadata,
			_systemPrompt?: string,
			_messages?: Anthropic.Messages.MessageParam[],
		): ApiStream {
			const apiKey = requireApiKey(this.options.openAiNativeApiKey, "OpenAI Native")
			const baseUrl = this.options.openAiNativeBaseUrl || "https://api.openai.com"
			const url = `${baseUrl}/v1/responses`

			this.abortController = new AbortController()
			const taskId = metadata?.taskId
			const userAgent = `roo-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`

			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
						originator: "roo-code",
						session_id: taskId || this.sessionId,
						"User-Agent": userAgent,
					},
					body: JSON.stringify(requestBody),
					signal: this.abortController.signal,
				})

				if (!response.ok) {
					const errorText = await response.text()
					let errorMessage = `OpenAI Responses API request failed (${response.status})`
					let errorDetails = ""

					try {
						const errorJson = openAiErrorResponseSchema.parse(JSON.parse(errorText))
						if (errorJson.error?.message) {
							errorDetails = errorJson.error.message
						} else if (errorJson.message) {
							errorDetails = errorJson.message
						} else {
							errorDetails = errorText
						}
					} catch {
						errorDetails = errorText
					}

					switch (response.status) {
						case 400:
							errorMessage = "Invalid request to Responses API. Please check your input parameters."
							break
						case 401:
							errorMessage = "Authentication failed. Please check your OpenAI API key."
							break
						case 403:
							errorMessage = "Access denied. Your API key may not have access to this endpoint."
							break
						case 404:
							errorMessage =
								"Responses API endpoint not found. The endpoint may not be available yet or requires a different configuration."
							break
						case 429:
							errorMessage = "Rate limit exceeded. Please try again later."
							break
						case 500:
						case 502:
						case 503:
							errorMessage = "OpenAI service error. Please try again later."
							break
						default:
							errorMessage = `Responses API error (${response.status})`
					}

					if (errorDetails) {
						errorMessage += ` - ${errorDetails}`
					}

					throw new ApiProviderError(errorMessage)
				}

				if (!response.body) {
					throw new ApiProviderError("Responses API error: No response body")
				}

				yield* parseSseStream(response.body, model, this as unknown as SseParserContext)
			} catch (error) {
				const model = this.getModel()
				const errorMessage = getErrorMessage(error)

				if (TelemetryService.hasInstance()) {
					const forTelemetry =
						error instanceof ApiProviderError ? error : new ApiProviderError(errorMessage, { cause: error })
					forTelemetry.provider = this.providerName
					forTelemetry.modelId = model.id
					forTelemetry.operation = "createMessage"
					TelemetryService.instance.captureException(forTelemetry)
				}

				if (error instanceof Error) {
					if (error.message.includes("Responses API")) {
						throw error instanceof ApiProviderError
							? error
							: new ApiProviderError(error.message, { cause: error })
					}
					throw new ApiProviderError(`Failed to connect to Responses API: ${error.message}`)
				}
				throw new ApiProviderError(`Unexpected error connecting to Responses API`)
			} finally {
				this.abortController = undefined
			}
		}
	}

	return ResponsesApiImpl as unknown as (new (...args: ConstructorParameters<T>) => InstanceType<T> & {
		createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[], metadata?: ApiHandlerCreateMessageMetadata): ApiStream
	}) & { prototype: InstanceType<T> }
}
