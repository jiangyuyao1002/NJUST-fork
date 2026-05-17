import { Anthropic } from "@anthropic-ai/sdk"
import { Stream as AnthropicStream } from "@anthropic-ai/sdk/streaming"
import { CacheControlEphemeral } from "@anthropic-ai/sdk/resources"

import {
	type ModelInfo,
	type AnthropicModelId,
	anthropicDefaultModelId,
	anthropicModels,
	ANTHROPIC_DEFAULT_MAX_TOKENS,
} from "@njust-ai-cj/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { logger } from "../../shared/logger"

import { ApiStream } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { filterNonAnthropicBlocks } from "../transform/anthropic-filter"
import { handleProviderError } from "./utils/error-handler"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { calculateApiCostAnthropic } from "../../shared/cost"
import {
	convertOpenAIToolsToAnthropic,
	convertOpenAIToolChoiceToAnthropic,
} from "../../core/prompts/tools/native-tools/converters"
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "../../core/prompts/system"
import { summarizePromptCacheUsage } from "../../core/prompts/cache-monitor"
import { globalCostTracker } from "../../utils/costTracker"
import { globalPromptCacheBreakDetector } from "../../core/prompts/promptCacheBreakDetection"

import { debugLog } from "../../utils/debugLog"
/**
 * Extended Tool type that includes cache_control for prompt caching.
 * The base Anthropic.Tool type in SDK ^0.37.0 does not include cache_control,
 * so we extend it here to maintain type safety.
 */
type AnthropicToolWithCache = Anthropic.Tool & {
	cache_control?: CacheControlEphemeral
}

export class AnthropicHandler extends BaseProvider implements SingleCompletionHandler {
	private options: ApiHandlerOptions
	private client: Anthropic
	private readonly providerName = "Anthropic"

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options

		const apiKeyFieldName =
			this.options.anthropicBaseUrl && this.options.anthropicUseAuthToken ? "authToken" : "apiKey"

		this.client = new Anthropic({
			baseURL: this.options.anthropicBaseUrl || undefined,
			[apiKeyFieldName]: this.options.apiKey,
		})
	}

	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		try {
			let stream: AnthropicStream<Anthropic.Messages.RawMessageStreamEvent>
			const cacheControl: CacheControlEphemeral = { type: "ephemeral" }
			const {
				id: modelId,
				betas = ["fine-grained-tool-streaming-2025-05-14"],
				maxTokens,
				temperature,
				reasoning: thinking,
			} = this.getModel()

			// Filter out non-Anthropic blocks (reasoning, thoughtSignature, etc.) before sending to the API
			const sanitizedMessages = filterNonAnthropicBlocks(messages)

			// Add 1M context beta flag if enabled for supported models (Claude Sonnet 4/4.5/4.6, Opus 4.6)
			if (
				(modelId === "claude-sonnet-4-20250514" ||
					modelId === "claude-sonnet-4-5" ||
					modelId === "claude-sonnet-4-6" ||
					modelId === "claude-opus-4-6") &&
				this.options.anthropicBeta1MContext
			) {
				betas.push("context-1m-2025-08-07")
			}

			const anthropicTools = convertOpenAIToolsToAnthropic(metadata?.tools ?? [])
			// Mark tool definitions with cache control so static tool schemas can benefit from prompt caching.
			// Anthropic accepts cache breakpoints on content blocks and tool definitions.
			const anthropicToolsWithCache: AnthropicToolWithCache[] = anthropicTools.map((tool, index) => ({
				...tool,
				...(index === anthropicTools.length - 1 ? { cache_control: cacheControl } : {}),
			})) as AnthropicToolWithCache[]
			const nativeToolParams = {
				tools: anthropicToolsWithCache,
				tool_choice: convertOpenAIToolChoiceToAnthropic(metadata?.tool_choice, metadata?.parallelToolCalls),
			}
			const split = systemPrompt.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
				? systemPrompt.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
				: null
			const systemBlocksWithCache =
				split && split.length >= 2
					? [
							{ text: split[0] ?? "", type: "text" as const, cache_control: cacheControl },
							{ text: split.slice(1).join(SYSTEM_PROMPT_DYNAMIC_BOUNDARY), type: "text" as const },
						]
					: [{ text: systemPrompt, type: "text" as const, cache_control: cacheControl }]
			// --- Prompt Cache Break Detection ---
			const staticPartText = split && split.length >= 2 ? (split[0] ?? "") : systemPrompt
			const dynamicPartText =
				split && split.length >= 2 ? split.slice(1).join(SYSTEM_PROMPT_DYNAMIC_BOUNDARY) : ""
			const cacheBreakEvent = globalPromptCacheBreakDetector.check(staticPartText, dynamicPartText)
			if (cacheBreakEvent) {
				logger.info(
					"Anthropic",
					`Cache break detected: source=${cacheBreakEvent.changeSource}, staticChanged=${cacheBreakEvent.staticPartChanged}, dynamicChanged=${cacheBreakEvent.dynamicPartChanged}, totalBreaks=${globalPromptCacheBreakDetector.getTotalBreaks()}`,
				)
			}

			const systemBlocksNoCache =
				split && split.length >= 2
					? [
							{ text: split[0] ?? "", type: "text" as const },
							{ text: split.slice(1).join(SYSTEM_PROMPT_DYNAMIC_BOUNDARY), type: "text" as const },
						]
					: [{ text: systemPrompt, type: "text" as const }]

			switch (modelId) {
				case "claude-sonnet-4-6":
				case "claude-sonnet-4-5":
				case "claude-sonnet-4-20250514":
				case "claude-opus-4-6":
				case "claude-opus-4-7":
				case "claude-opus-4-5-20251101":
				case "claude-opus-4-1-20250805":
				case "claude-opus-4-20250514":
				case "claude-3-7-sonnet-20250219":
				case "claude-3-5-sonnet-20241022":
				case "claude-3-5-haiku-20241022":
				case "claude-3-opus-20240229":
				case "claude-haiku-4-5-20251001":
				case "claude-3-haiku-20240307": {
					/**
					 * The latest message will be the new user message, one before
					 * will be the assistant message from a previous request, and
					 * the user message before that will be a previously cached user
					 * message. So we need to mark the latest user message as
					 * ephemeral to cache it for the next request, and mark the
					 * second to last user message as ephemeral to let the server
					 * know the last message to retrieve from the cache for the
					 * current request.
					 */
					const userMsgIndices = sanitizedMessages.reduce(
						(acc, msg, index) => (msg.role === "user" ? [...acc, index] : acc),
						[] as number[],
					)

					const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
					const secondLastMsgUserIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

					stream = await this.withRetry(() =>
						this.client.messages.create(
							{
								model: modelId,
								max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
								temperature,
								thinking,
								// Setting cache breakpoint for system prompt so new tasks can reuse it.
								system: systemBlocksWithCache,
								messages: sanitizedMessages.map((message, index) => {
									if (index === lastUserMsgIndex || index === secondLastMsgUserIndex) {
										return {
											...message,
											content:
												typeof message.content === "string"
													? [{ type: "text", text: message.content, cache_control: cacheControl }]
													: message.content.map((content, contentIndex) =>
															contentIndex === message.content.length - 1
																? { ...content, cache_control: cacheControl }
																: content,
														),
										}
									}
									return message
								}),
								stream: true,
								...nativeToolParams,
							},
							// Prompt caching is now GA — no special beta header needed.
							// Pass remaining betas (e.g. fine-grained-tool-streaming, context-1m) if any.
							betas && betas.length > 0 ? { headers: { "anthropic-beta": betas.join(",") } } : undefined,
						),
					)
					break
				}
				default: {
					stream = (await this.withRetry(() =>
						this.client.messages.create({
							model: modelId,
							max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
							temperature,
							system: systemBlocksNoCache,
							messages: sanitizedMessages,
							stream: true,
							...nativeToolParams,
						}),
					)) as UnsafeAny
					break
				}
			}

			let inputTokens = 0
			let outputTokens = 0
			let cacheWriteTokens = 0
			let cacheReadTokens = 0

			for await (const chunk of stream) {
				switch (chunk.type) {
					case "message_start": {
						// Tells us cache reads/writes/input/output.
						const {
							input_tokens = 0,
							output_tokens = 0,
							cache_creation_input_tokens,
							cache_read_input_tokens,
						} = chunk.message.usage

						yield {
							type: "usage",
							inputTokens: input_tokens,
							outputTokens: output_tokens,
							cacheWriteTokens: cache_creation_input_tokens || undefined,
							cacheReadTokens: cache_read_input_tokens || undefined,
						}

						inputTokens += input_tokens
						outputTokens += output_tokens
						cacheWriteTokens += cache_creation_input_tokens || 0
						cacheReadTokens += cache_read_input_tokens || 0
						if ((cache_creation_input_tokens || 0) > 0 || (cache_read_input_tokens || 0) > 0) {
							debugLog(
								`[AnthropicHandler] ${summarizePromptCacheUsage({ cacheReadInputTokens: cache_read_input_tokens ?? undefined, cacheCreationInputTokens: cache_creation_input_tokens ?? undefined })}`,
							)
						}
						if (cache_read_input_tokens !== undefined) {
							debugLog(
								`[Anthropic Cache] read: ${cache_read_input_tokens}, ` +
									`creation: ${cache_creation_input_tokens ?? 0}`,
							)
						}

						break
					}
					case "message_delta":
						// Tells us stop_reason, stop_sequence, and output tokens
						// along the way and at the end of the message.
						yield {
							type: "usage",
							inputTokens: 0,
							outputTokens: chunk.usage.output_tokens || 0,
						}

						break
					case "message_stop":
						// No usage data, just an indicator that the message is done.
						break
					case "content_block_start":
						switch (chunk.content_block.type) {
							case "thinking":
								// We may receive multiple text blocks, in which
								// case just insert a line break between them.
								if (chunk.index > 0) {
									yield { type: "reasoning", text: "\n" }
								}

								yield { type: "reasoning", text: chunk.content_block.thinking }
								break
							case "text":
								// We may receive multiple text blocks, in which
								// case just insert a line break between them.
								if (chunk.index > 0) {
									yield { type: "text", text: "\n" }
								}

								yield { type: "text", text: chunk.content_block.text }
								break
							case "tool_use": {
								// Emit initial tool call partial with id and name
								yield {
									type: "tool_call_partial",
									index: chunk.index,
									id: chunk.content_block.id,
									name: chunk.content_block.name,
									arguments: undefined,
								}
								break
							}
						}
						break
					case "content_block_delta":
						switch (chunk.delta.type) {
							case "thinking_delta":
								yield { type: "reasoning", text: chunk.delta.thinking }
								break
							case "text_delta":
								yield { type: "text", text: chunk.delta.text }
								break
							case "input_json_delta": {
								// Emit tool call partial chunks as arguments stream in
								yield {
									type: "tool_call_partial",
									index: chunk.index,
									id: undefined,
									name: undefined,
									arguments: chunk.delta.partial_json,
								}
								break
							}
						}

						break
					case "content_block_stop":
						// Block complete - no action needed for now.
						// NativeToolCallParser handles tool call completion
						// Note: Signature for multi-turn thinking would require using stream.finalMessage()
						// after iteration completes, which requires restructuring the streaming approach.
						break
				}
			}

			if (inputTokens > 0 || outputTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0) {
				const modelInfo = this.getModel().info
				const { totalCost } = calculateApiCostAnthropic(
					modelInfo,
					inputTokens,
					outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
				)

				// Hypothetical cost if all input tokens were billed at full price (no caching)
				const { totalCost: noCacheCost } = calculateApiCostAnthropic(
					modelInfo,
					inputTokens + cacheWriteTokens + cacheReadTokens,
					outputTokens,
				)

				yield {
					type: "usage",
					inputTokens: 0,
					outputTokens: 0,
					totalCost,
				}

				// Track cost and usage metrics
				globalCostTracker.recordUsage(modelId, {
					inputTokens,
					outputTokens,
					cacheReadInputTokens: cacheReadTokens,
					cacheCreationInputTokens: cacheWriteTokens,
					costUSD: totalCost,
					noCacheCostUSD: noCacheCost,
				})
			}
		} catch (error) {
			// Handle errors during API call or streaming
			throw handleProviderError(error, this.providerName, { messagePrefix: "streaming" })
		}
	}

	getModel() {
		const modelId = this.options.apiModelId
		const id = modelId && modelId in anthropicModels ? (modelId as AnthropicModelId) : anthropicDefaultModelId
		let info: ModelInfo = anthropicModels[id]

		// If 1M context beta is enabled for supported models, update the model info
		if (
			(id === "claude-sonnet-4-20250514" ||
				id === "claude-sonnet-4-5" ||
				id === "claude-sonnet-4-6" ||
				id === "claude-opus-4-6") &&
			this.options.anthropicBeta1MContext
		) {
			// Use the tier pricing for 1M context
			const tier = info.tiers?.[0]
			if (tier) {
				info = {
					...info,
					contextWindow: tier.contextWindow,
					inputPrice: tier.inputPrice,
					outputPrice: tier.outputPrice,
					cacheWritesPrice: tier.cacheWritesPrice,
					cacheReadsPrice: tier.cacheReadsPrice,
				}
			}
		}

		const params = getModelParams({
			format: "anthropic",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		// The `:thinking` suffix indicates that the model is a "Hybrid"
		// reasoning model and that reasoning is required to be enabled.
		// The actual model ID honored by Anthropic's API does not have this
		// suffix.
		return {
			id: id === "claude-3-7-sonnet-20250219:thinking" ? "claude-3-7-sonnet-20250219" : id,
			info,
			betas: id === "claude-3-7-sonnet-20250219:thinking" ? ["output-128k-2025-02-19"] : undefined,
			...params,
		}
	}

	async completePrompt(prompt: string) {
		const { id: model, temperature } = this.getModel()

		const message = await this.withRetry(() => this.client.messages.create({
			model,
			max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
			thinking: undefined,
			temperature,
			messages: [{ role: "user", content: prompt }],
			stream: false,
		}))

		const content = message.content.find(({ type }) => type === "text")
		return content?.type === "text" ? content.text : ""
	}
}
