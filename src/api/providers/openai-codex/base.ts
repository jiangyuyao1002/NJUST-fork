import { ensureAllRequired, ensureAdditionalPropertiesFalse } from "../schema-utils"
import { v7 as uuidv7 } from "uuid"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { type ModelInfo, type ReasoningEffortExtended } from "@njust-ai/types"
import { openAiCodexDefaultModelId, OpenAiCodexModelId, openAiCodexModels } from "@njust-ai/core/providers"

import type { ApiHandlerOptions } from "../../../shared/api"

import { ApiStream, ApiStreamUsageChunk } from "../../transform/stream"
import { getModelParams } from "../../transform/model-params"

import { BaseProvider } from "../base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../../types"
import { isMcpTool } from "../../../utils/mcp-name"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { t } from "../../../i18n"

import {
	type OpenAiCodexModel,
	type OpenAiCodexUsageData,
	type CodexInputItem,
	type ResponsesOutputItem,
	type ResponsesStreamEvent,
	type ResponsesRequestBody,
	type ResponsesClientLike,
	codexErrorResponseSchema,
	codexResponsesStreamEventSchema,
} from "./types"
import { formatConversation } from "./formatConversation"
import { processEvent, type CodexEventHandlerContext } from "./processEvent"
import { getApiRequestTimeout } from "../utils/timeout-config"
import { buildCodexHeaders, executeNonStreamingRequest } from "./completePrompt"

/**
 * OpenAI Codex base URL for API requests.
 * Per the implementation guide: requests are routed to chatgpt.com/backend-api/codex.
 */
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiNativeHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 *
 * Refactored: types, conversation formatting, event processing, and
 * non-streaming completion are extracted to sibling modules in openai-codex/.
 */
export class OpenAiCodexHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private readonly providerName = "OpenAI Codex"
	private client?: OpenAI

	// Complete response output array
	lastResponseOutput: ResponsesOutputItem[] | undefined
	// Last top-level response id
	lastResponseId: string | undefined
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string

	/**
	 * Some Codex/Responses streams emit tool-call argument deltas without stable call id/name.
	 * Track the last observed tool identity from output_item events so we can still
	 * emit `tool_call_partial` chunks (tool-call-only streams).
	 */
	pendingToolCallId: string | undefined
	pendingToolCallName: string | undefined
	// Tracks whether this response already emitted text to avoid duplicate done-event rendering.
	sawTextOutputInCurrentResponse = false
	// Tracks whether text arrived through delta events so content_part events can be treated as fallback-only.
	sawTextDeltaInCurrentResponse = false
	// Tracks tool call IDs emitted via streaming partial events to prevent done-event duplicates.
	streamedToolCallIds = new Set<string>()

	// Event types handled by the shared event processor
	private readonly coreHandledEventTypes = new Set<string>([
		"response.text.delta",
		"response.output_text.delta",
		"response.text.done",
		"response.output_text.done",
		"response.content_part.added",
		"response.content_part.done",
		"response.reasoning.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary.delta",
		"response.reasoning_summary_text.delta",
		"response.refusal.delta",
		"response.output_item.added",
		"response.output_item.done",
		"response.done",
		"response.completed",
		"response.tool_call_arguments.delta",
		"response.function_call_arguments.delta",
		"response.tool_call_arguments.done",
		"response.function_call_arguments.done",
	])

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		// Generate a new session ID for standalone handler usage (fallback)
		this.sessionId = uuidv7()
	}

	/**
	 * Returns an event handler context backed by this instance.
	 * The handler class itself satisfies CodexEventHandlerContext structurally.
	 */
	private get eventHandlerContext(): CodexEventHandlerContext {
		return this as unknown as CodexEventHandlerContext
	}

	// -------------------------------------------------------------------------
	// Usage normalization
	// -------------------------------------------------------------------------

	normalizeUsage(usage: unknown, _model: OpenAiCodexModel): ApiStreamUsageChunk | undefined {
		if (!usage || typeof usage !== "object") return undefined
		const u = usage as OpenAiCodexUsageData

		const inputDetails = u.input_tokens_details ?? u.prompt_tokens_details

		const cachedFromDetails = inputDetails?.cached_tokens ?? 0
		const missFromDetails = inputDetails?.cache_miss_tokens ?? 0

		let totalInputTokens = u.input_tokens ?? u.prompt_tokens ?? 0
		if (totalInputTokens === 0 && inputDetails && (cachedFromDetails > 0 || missFromDetails > 0)) {
			totalInputTokens = cachedFromDetails + missFromDetails
		}

		const totalOutputTokens = u.output_tokens ?? u.completion_tokens ?? 0
		const cacheWriteTokens = u.cache_creation_input_tokens ?? u.cache_write_tokens ?? 0
		const cacheReadTokens =
			u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_tokens ?? cachedFromDetails ?? 0

		const reasoningTokens =
			typeof u.output_tokens_details?.reasoning_tokens === "number"
				? u.output_tokens_details.reasoning_tokens
				: undefined

		// Subscription-based: no per-token costs
		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: 0, // Subscription-based pricing
		}
		return out
	}

	// -------------------------------------------------------------------------
	// Streaming entry point
	// -------------------------------------------------------------------------

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		yield* this.guardEmptyStream(this.createMessageInner(systemPrompt, messages, metadata))
	}

	protected async *createMessageInner(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()
		yield* this.handleResponsesApiMessage(model, systemPrompt, messages, metadata)
	}

	private async *handleResponsesApiMessage(
		model: OpenAiCodexModel,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Reset state for this request
		this.lastResponseOutput = undefined
		this.lastResponseId = undefined
		this.pendingToolCallId = undefined
		this.pendingToolCallName = undefined
		this.sawTextOutputInCurrentResponse = false
		this.sawTextDeltaInCurrentResponse = false
		this.streamedToolCallIds.clear()

		// Get access token from OAuth manager
		const accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error(
				t("common:errors.openAiCodex.notAuthenticated", {
					defaultValue:
						"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
				}),
			)
		}

		// Resolve reasoning effort
		const reasoningEffort = this.getReasoningEffort(model)

		// Format conversation using extracted pure function
		const formattedInput = formatConversation(systemPrompt, messages)

		// Build request body
		const requestBody = this.buildRequestBody(model, formattedInput, systemPrompt, reasoningEffort, metadata)

		// Make the request
		yield* this.executeRequest(requestBody, model, accessToken, metadata?.taskId)
	}

	// -------------------------------------------------------------------------
	// Request building
	// -------------------------------------------------------------------------

	private buildRequestBody(
		model: OpenAiCodexModel,
		formattedInput: CodexInputItem[],
		systemPrompt: string,
		reasoningEffort: ReasoningEffortExtended | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): ResponsesRequestBody {
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
							summary: "auto" as const,
						},
					}
				: {}),
			tools: (metadata?.tools ?? [])
				.filter((tool) => tool.type === "function")
				.map((tool) => {
					const isMcp = isMcpTool(tool.function.name)
					return {
						type: "function",
						name: tool.function.name,
						description: tool.function.description,
						parameters: isMcp
							? ensureAdditionalPropertiesFalse(tool.function.parameters)
							: ensureAllRequired(tool.function.parameters),
						strict: !isMcp,
					}
				}),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? false,
		}

		return body
	}

	// -------------------------------------------------------------------------
	// Request execution (SDK path with SSE fallback)
	// -------------------------------------------------------------------------

	private async *executeRequest(
		requestBody: ResponsesRequestBody,
		model: OpenAiCodexModel,
		accessToken: string,
		taskId?: string,
	): ApiStream {
		this.abortController = new AbortController()

		try {
			try {
				const codexHeaders = await buildCodexHeaders(accessToken, taskId || this.sessionId)

				const client =
					this.client ??
					new OpenAI({
						apiKey: accessToken,
						baseURL: CODEX_API_BASE_URL,
						defaultHeaders: codexHeaders,
						timeout: getApiRequestTimeout(),
					})

				const stream = await (client as UnsafeAny as ResponsesClientLike).responses.create(requestBody, {
					signal: this.abortController.signal,
					headers: codexHeaders,
				})

				if (typeof stream[Symbol.asyncIterator] !== "function") {
					throw new Error(
						"OpenAI SDK did not return an AsyncIterable for Responses API streaming. Falling back to SSE.",
					)
				}

				const ctx = this.eventHandlerContext

				for await (const event of stream) {
					if (this.abortController.signal.aborted) {
						break
					}

					for await (const outChunk of processEvent(event, model, ctx)) {
						if (outChunk.type === "text") {
							this.sawTextOutputInCurrentResponse = true
						}
						yield outChunk
					}
				}
			} catch (_sdkErr) {
				// Fallback to manual SSE via fetch (Codex backend)
				yield* this.makeCodexRequest(requestBody, model, accessToken, taskId)
			}
		} finally {
			this.abortController = undefined
		}
	}

	// -------------------------------------------------------------------------
	// SSE fallback stream handler
	// -------------------------------------------------------------------------

	private async *makeCodexRequest(
		requestBody: ResponsesRequestBody,
		model: OpenAiCodexModel,
		accessToken: string,
		taskId?: string,
	): ApiStream {
		const url = `${CODEX_API_BASE_URL}/responses`

		const headers = await buildCodexHeaders(accessToken, taskId || this.sessionId, {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		})

		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController?.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()

				let errorMessage = t("common:errors.api.apiRequestFailed", { status: response.status })
				let errorDetails = ""

				try {
					const errorJson = codexErrorResponseSchema.parse(JSON.parse(errorText))
					if (errorJson.error?.message) {
						errorDetails = errorJson.error.message
					} else if (errorJson.message) {
						errorDetails = errorJson.message
					} else if (errorJson.detail) {
						errorDetails = errorJson.detail
					} else {
						errorDetails = errorText
					}
				} catch {
					errorDetails = errorText
				}

				switch (response.status) {
					case 400:
						errorMessage = t("common:errors.openAiCodex.invalidRequest")
						break
					case 401:
						errorMessage = t("common:errors.openAiCodex.authenticationFailed")
						break
					case 403:
						errorMessage = t("common:errors.openAiCodex.accessDenied")
						break
					case 404:
						errorMessage = t("common:errors.openAiCodex.endpointNotFound")
						break
					case 429:
						errorMessage = t("common:errors.openAiCodex.rateLimitExceeded")
						break
					case 500:
					case 502:
					case 503:
						errorMessage = t("common:errors.openAiCodex.serviceError")
						break
					default:
						errorMessage = t("common:errors.openAiCodex.genericError", { status: response.status })
				}

				if (errorDetails) {
					errorMessage += ` - ${errorDetails}`
				}

				throw new Error(errorMessage)
			}

			if (!response.body) {
				throw new Error(t("common:errors.openAiCodex.noResponseBody"))
			}

			yield* this.handleStreamResponse(response.body, model)
		} catch (error) {
			if (error instanceof Error) {
				if (error.message.includes("Codex API")) {
					throw error
				}
				throw new Error(t("common:errors.openAiCodex.connectionFailed", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedConnectionError"))
		}
	}

	private async *handleStreamResponse(body: ReadableStream<Uint8Array>, model: OpenAiCodexModel): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let hasContent = false
		const ctx = this.eventHandlerContext

		try {
			while (true) {
				if (this.abortController?.signal.aborted) {
					break
				}

				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim()
						if (data === "[DONE]") {
							continue
						}

						try {
							const parsed = codexResponsesStreamEventSchema.parse(
								JSON.parse(data),
							) as ResponsesStreamEvent

							// Capture response metadata
							if (parsed.response?.output && Array.isArray(parsed.response.output)) {
								this.lastResponseOutput = parsed.response.output
							}
							if (parsed.response?.id) {
								this.lastResponseId = parsed.response.id as string
							}

							// Delegate standard event types to the extracted processEvent
							if (parsed?.type && this.coreHandledEventTypes.has(parsed.type)) {
								// Capture tool call identity from output_item events
								if (
									parsed.type === "response.output_item.added" ||
									parsed.type === "response.output_item.done"
								) {
									const item = parsed.item
									if (item && (item.type === "function_call" || item.type === "tool_call")) {
										const callId = item.call_id || item.tool_call_id || item.id
										const name = item.name || item.function?.name || item.function_name
										if (typeof callId === "string" && callId.length > 0) {
											this.pendingToolCallId = callId
											this.pendingToolCallName = typeof name === "string" ? name : undefined
										}
									}
								}

								// Some Codex streams only return tool calls (no text)
								if (
									parsed.type === "response.function_call_arguments.delta" ||
									parsed.type === "response.tool_call_arguments.delta" ||
									parsed.type === "response.output_item.added" ||
									parsed.type === "response.output_item.done"
								) {
									hasContent = true
								}

								for await (const outChunk of processEvent(parsed, model, ctx)) {
									if (outChunk.type === "text" || outChunk.type === "reasoning") {
										hasContent = true
										if (outChunk.type === "text") {
											this.sawTextOutputInCurrentResponse = true
										}
									}
									yield outChunk
								}
								continue
							}

							// Handle complete response
							if (parsed.response?.output && Array.isArray(parsed.response.output)) {
								for (const outputItem of parsed.response.output) {
									if (outputItem.type === "text" && outputItem.content) {
										for (const content of outputItem.content) {
											if (content.type === "text" && content.text) {
												hasContent = true
												this.sawTextOutputInCurrentResponse = true
												yield { type: "text", text: content.text }
											}
										}
									}
									if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
										for (const summary of outputItem.summary) {
											if (summary?.type === "summary_text" && typeof summary.text === "string") {
												hasContent = true
												yield { type: "reasoning", text: summary.text }
											}
										}
									}
								}
								if (parsed.response.usage) {
									const usageData = this.normalizeUsage(parsed.response.usage, model)
									if (usageData) {
										yield usageData
									}
								}
							} else if (
								parsed.type === "response.text.delta" ||
								parsed.type === "response.output_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: parsed.delta }
								}
							} else if (
								(parsed.type === "response.text.done" || parsed.type === "response.output_text.done") &&
								!hasContent
							) {
								const doneText =
									typeof parsed.text === "string"
										? parsed.text
										: typeof parsed.output_text === "string"
											? parsed.output_text
											: typeof parsed.delta === "string"
												? parsed.delta
												: undefined
								if (doneText) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: doneText }
								}
							} else if (
								parsed.type === "response.reasoning.delta" ||
								parsed.type === "response.reasoning_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									yield { type: "reasoning", text: parsed.delta }
								}
							} else if (
								parsed.type === "response.reasoning_summary.delta" ||
								parsed.type === "response.reasoning_summary_text.delta"
							) {
								if (parsed.delta) {
									hasContent = true
									yield { type: "reasoning", text: parsed.delta }
								}
							} else if (parsed.type === "response.refusal.delta") {
								if (parsed.delta) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: `[Refusal] ${parsed.delta}` }
								}
							} else if (parsed.type === "response.output_item.added") {
								if (parsed.item) {
									if (parsed.item.type === "text" && parsed.item.text) {
										hasContent = true
										this.sawTextOutputInCurrentResponse = true
										yield { type: "text", text: parsed.item.text }
									} else if (parsed.item.type === "reasoning" && parsed.item.text) {
										hasContent = true
										yield { type: "reasoning", text: parsed.item.text }
									} else if (parsed.item.type === "message" && parsed.item.content) {
										for (const content of parsed.item.content) {
											if (content.type === "text" && content.text) {
												hasContent = true
												this.sawTextOutputInCurrentResponse = true
												yield { type: "text", text: content.text }
											}
										}
									}
								}
							} else if (parsed.type === "response.error" || parsed.type === "error") {
								if (parsed.error || parsed.message) {
									throw new Error(
										t("common:errors.openAiCodex.apiError", {
											message: parsed.error?.message || parsed.message || "Unknown error",
										}),
									)
								}
							} else if (parsed.type === "response.failed") {
								if (parsed.error || parsed.message) {
									throw new Error(
										t("common:errors.openAiCodex.responseFailed", {
											message: parsed.error?.message || parsed.message || "Unknown failure",
										}),
									)
								}
							} else if (parsed.type === "response.completed" || parsed.type === "response.done") {
								if (parsed.response?.output && Array.isArray(parsed.response.output)) {
									this.lastResponseOutput = parsed.response.output
								}
								if (parsed.response?.id) {
									this.lastResponseId = parsed.response.id as string
								}

								if (!hasContent && parsed.response?.output && Array.isArray(parsed.response.output)) {
									for (const outputItem of parsed.response.output) {
										if (outputItem.type === "message" && outputItem.content) {
											for (const content of outputItem.content) {
												if (content.type === "output_text" && content.text) {
													hasContent = true
													this.sawTextOutputInCurrentResponse = true
													yield { type: "text", text: content.text }
												}
											}
										}
										if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
											for (const summary of outputItem.summary) {
												if (
													summary?.type === "summary_text" &&
													typeof summary.text === "string"
												) {
													hasContent = true
													yield { type: "reasoning", text: summary.text }
												}
											}
										}
									}
								}
							} else if (parsed.choices?.[0]?.delta?.content) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.choices[0].delta.content }
							} else if (
								parsed.item &&
								typeof parsed.item.text === "string" &&
								parsed.item.text.length > 0
							) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.item.text }
							} else if (parsed.usage) {
								const usageData = this.normalizeUsage(parsed.usage, model)
								if (usageData) {
									yield usageData
								}
							}
						} catch (e) {
							if (!(e instanceof SyntaxError)) {
								throw e
							}
						}
					} else if (line.trim() && !line.startsWith(":")) {
						try {
							const parsed = codexResponsesStreamEventSchema.parse(
								JSON.parse(line),
							) as ResponsesStreamEvent
							if (parsed.content || parsed.text || parsed.message) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.content || parsed.text || parsed.message }
							}
						} catch {
							// Not JSON, ignore
						}
					}
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.streamProcessingError", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedStreamError"))
		} finally {
			reader.releaseLock()
		}
	}

	// -------------------------------------------------------------------------
	// Model & metadata accessors
	// -------------------------------------------------------------------------

	private getReasoningEffort(model: OpenAiCodexModel): ReasoningEffortExtended | undefined {
		const selected = this.options.reasoningEffort ?? model.info.reasoningEffort
		return selected && selected !== "disable" && selected !== "none"
			? (selected as ReasoningEffortExtended)
			: undefined
	}

	override getModel() {
		const modelId = this.options.apiModelId

		const id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId

		const info: ModelInfo = openAiCodexModels[id]

		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, ...params }
	}

	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		if (!this.lastResponseOutput) return undefined

		const reasoningItem = this.lastResponseOutput.find(
			(item) => item.type === "reasoning" && item.encrypted_content,
		)

		if (!reasoningItem?.encrypted_content) return undefined

		return {
			encrypted_content: reasoningItem.encrypted_content,
			...(reasoningItem.id ? { id: reasoningItem.id } : {}),
		}
	}

	getResponseId(): string | undefined {
		return this.lastResponseId
	}

	// -------------------------------------------------------------------------
	// Non-streaming completion
	// -------------------------------------------------------------------------

	async completePrompt(prompt: string): Promise<string> {
		this.abortController = new AbortController()

		try {
			const model = this.getModel()

			const accessToken = await openAiCodexOAuthManager.getAccessToken()
			if (!accessToken) {
				throw new Error(
					t("common:errors.openAiCodex.notAuthenticated", {
						defaultValue:
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
					}),
				)
			}

			const reasoningEffort = this.getReasoningEffort(model)

			const requestBody: UnsafeAny = {
				model: model.id,
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: prompt }],
					},
				],
				stream: false,
				store: false,
				...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			}

			if (reasoningEffort) {
				requestBody.reasoning = {
					effort: reasoningEffort,
					summary: "auto" as const,
				}
			}

			return await executeNonStreamingRequest(
				requestBody,
				accessToken,
				this.sessionId,
				this.abortController.signal,
			)
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.completionError", { message: error.message }))
			}
			throw error
		} finally {
			this.abortController = undefined
		}
	}
}
