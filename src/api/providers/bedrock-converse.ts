import {
	ConverseStreamCommand,
	type ContentBlock,
	type Message,
	type SystemContentBlock,
	type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime"
import { Anthropic } from "@anthropic-ai/sdk"

import { BEDROCK_1M_CONTEXT_MODEL_IDS, BEDROCK_SERVICE_TIER_MODEL_IDS } from "@njust-ai/core/providers"

import { ApiStream } from "../transform/stream"
import { MultiPointStrategy } from "../transform/cache-strategy/multi-point-strategy"
import { ModelInfo as CacheModelInfo } from "../transform/cache-strategy/types"
import { convertToBedrockConverseMessages as sharedConverter } from "../transform/bedrock-converse-format"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { logger } from "../../utils/logging"
import { shouldUseReasoningBudget } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata } from "../types"
import { convertToolsForBedrock, convertToolChoiceForBedrock } from "./bedrock-tools"
import {
	type BedrockAdditionalModelFields,
	type BedrockInferenceConfig,
	type BedrockPayloadWithServiceTier,
	type StreamEvent,
	type UsageType,
	bedrockStreamEventSchema,
} from "./bedrock-types"

/************************************************************************************
 *
 *     CONVERSE STREAM
 *
 *     The streaming core of AwsBedrockHandler. Kept as a free async generator
 *     so that AwsBedrockHandler can be reduced to thin wrappers. The handler
 *     is passed as the first argument so we can reach back into its private
 *     state (client, options, getModel, parseArn, getModelById, etc.) without
 *     changing any of the original logic.
 *
 *************************************************************************************/

/**
 * Shape of the handler bits the streaming loop touches. Typed as a structural
 * shape that matches AwsBedrockHandler's relevant members without forcing the
 * class to declare a conformance interface.
 */
export type BedrockConverseHandler = UnsafeAny

export async function* bedrockCreateMessageInner(
	handler: BedrockConverseHandler,
	systemPrompt: string,
	messages: Anthropic.Messages.MessageParam[],
	metadata?: ApiHandlerCreateMessageMetadata & {
		thinking?: {
			enabled: boolean
			maxTokens?: number
			maxThinkingTokens?: number
		}
	},
): ApiStream {
	const modelConfig = handler.getModel()
	const usePromptCache = Boolean(
		(handler.options.awsUsePromptCache ?? true) && handler.supportsAwsPromptCache(modelConfig),
	)

	const conversationId =
		messages.length > 0
			? `conv_${messages[0]!.role}_${
					typeof messages[0]!.content === "string" ? messages[0]!.content.substring(0, 20) : "complex_content"
				}`
			: "default_conversation"

	const formatted = handler.convertToBedrockConverseMessages(
		messages,
		systemPrompt,
		usePromptCache,
		modelConfig.info,
		conversationId,
	)

	const baseModelId = handler.parseBaseModelId(modelConfig.id)
	const isBedrockClaudeOpus47 = baseModelId === "anthropic.claude-opus-4-7"

	let additionalModelRequestFields: BedrockAdditionalModelFields | undefined
	let thinkingEnabled = false

	// Determine if thinking should be enabled
	// metadata?.thinking?.enabled: Explicitly enabled through API metadata (direct request)
	// shouldUseReasoningBudget(): Enabled through user settings (enableReasoningEffort = true)
	const isThinkingExplicitlyEnabled = metadata?.thinking?.enabled
	const isThinkingEnabledBySettings =
		shouldUseReasoningBudget({ model: modelConfig.info, settings: handler.options }) &&
		modelConfig.reasoning &&
		modelConfig.reasoningBudget

	if ((isThinkingExplicitlyEnabled || isThinkingEnabledBySettings) && modelConfig.info.supportsReasoningBudget) {
		thinkingEnabled = true
		// Claude Opus 4.7 on Bedrock only supports adaptive thinking (not enabled + budget_tokens).
		// https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-7.html
		if (isBedrockClaudeOpus47) {
			additionalModelRequestFields = {
				thinking: { type: "adaptive" },
			}
		} else {
			additionalModelRequestFields = {
				thinking: {
					type: "enabled",
					budget_tokens: metadata?.thinking?.maxThinkingTokens || modelConfig.reasoningBudget || 4096,
				},
			}
		}
		logger.info("Extended thinking enabled for Bedrock request", {
			ctx: "bedrock",
			modelId: modelConfig.id,
			thinking: additionalModelRequestFields.thinking,
		})
	}

	const inferenceConfig: BedrockInferenceConfig = {
		maxTokens: modelConfig.maxTokens || (modelConfig.info.maxTokens as number),
		...(!isBedrockClaudeOpus47 && {
			temperature: modelConfig.temperature ?? (handler.options.modelTemperature as number),
		}),
	}

	// Check if 1M context is enabled for supported Claude 4 models
	// Use parseBaseModelId to handle cross-region inference prefixes
	const is1MContextEnabled =
		(BEDROCK_1M_CONTEXT_MODEL_IDS as readonly string[]).includes(baseModelId) && handler.options.awsBedrock1MContext

	// Determine if service tier should be applied (checked later when building payload)
	const useServiceTier =
		handler.options.awsBedrockServiceTier &&
		(BEDROCK_SERVICE_TIER_MODEL_IDS as readonly string[]).includes(baseModelId)
	if (useServiceTier) {
		logger.info("Service tier specified for Bedrock request", {
			ctx: "bedrock",
			modelId: modelConfig.id,
			serviceTier: handler.options.awsBedrockServiceTier,
		})
	}

	// Add anthropic_beta headers for various features
	// Start with an empty array and add betas as needed
	const anthropicBetas: string[] = []

	// Add 1M context beta if enabled
	if (is1MContextEnabled) {
		anthropicBetas.push("context-1m-2025-08-07")
	}

	// Add fine-grained tool streaming beta for Claude models
	// This enables proper tool use streaming for Anthropic models on Bedrock
	if (baseModelId.includes("claude")) {
		anthropicBetas.push("fine-grained-tool-streaming-2025-05-14")
	}

	// Apply anthropic_beta to additionalModelRequestFields if any betas are needed
	if (anthropicBetas.length > 0) {
		if (!additionalModelRequestFields) {
			additionalModelRequestFields = {} as BedrockAdditionalModelFields
		}
		additionalModelRequestFields.anthropic_beta = anthropicBetas
	}

	const toolConfig: ToolConfiguration = {
		tools: convertToolsForBedrock(metadata?.tools ?? []),
		toolChoice: convertToolChoiceForBedrock(metadata?.tool_choice),
	}

	// Build payload with optional service_tier at top level
	// Service tier is a top-level parameter per AWS documentation, NOT inside additionalModelRequestFields
	// https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html
	const payload: BedrockPayloadWithServiceTier = {
		modelId: modelConfig.id,
		messages: formatted.messages,
		system: formatted.system,
		inferenceConfig,
		...(additionalModelRequestFields && { additionalModelRequestFields }),
		// Add anthropic_version at top level when using thinking features
		...(thinkingEnabled && { anthropic_version: "bedrock-2023-05-31" }),
		toolConfig,
		// Add service_tier as a top-level parameter (not inside additionalModelRequestFields)
		...(useServiceTier && { service_tier: handler.options.awsBedrockServiceTier }),
	}

	// Create AbortController with configurable timeout (from VSCode settings, default 300s)
	const controller = new AbortController()
	let timeoutId: NodeJS.Timeout | undefined

	try {
		timeoutId = setTimeout(() => {
			controller.abort()
		}, getApiRequestTimeout())

		const command = new ConverseStreamCommand(payload)
		const response = await handler.client.send(command, {
			abortSignal: controller.signal,
		})

		if (!response.stream) {
			clearTimeout(timeoutId)
			throw new Error("No stream available in the response")
		}

		for await (const chunk of response.stream) {
			// Parse the chunk as JSON if it's a string (for tests)
			let streamEvent: StreamEvent
			try {
				streamEvent =
					typeof chunk === "string"
						? (bedrockStreamEventSchema.parse(JSON.parse(chunk)) as StreamEvent)
						: (chunk as UnsafeAny as StreamEvent)
			} catch (e) {
				logger.error("Failed to parse stream event", {
					ctx: "bedrock",
					error: e instanceof Error ? e : String(e),
					chunk: typeof chunk === "string" ? chunk : "binary data",
				})
				continue
			}

			// Handle metadata events first
			if (streamEvent.metadata?.usage) {
				const usage = (streamEvent.metadata?.usage || {}) as UsageType

				// Check both field naming conventions for cache tokens
				const cacheReadTokens = usage.cacheReadInputTokens || usage.cacheReadInputTokenCount || 0
				const cacheWriteTokens = usage.cacheWriteInputTokens || usage.cacheWriteInputTokenCount || 0

				// Always include all available token information
				yield {
					type: "usage",
					inputTokens: usage.inputTokens || 0,
					outputTokens: usage.outputTokens || 0,
					cacheReadTokens: cacheReadTokens,
					cacheWriteTokens: cacheWriteTokens,
				}
				continue
			}

			if (streamEvent?.trace?.promptRouter?.invokedModelId) {
				try {
					//update the in-use model info to be based on the invoked Model Id for the router
					//so that pricing, context window, caching etc have values that can be used
					//However, we want to keep the id of the model to be the ID for the router for
					//subsequent requests so they are sent back through the router
					const invokedArnInfo = handler.parseArn(streamEvent.trace.promptRouter.invokedModelId)
					const invokedModel = handler.getModelById(
						invokedArnInfo.modelId as string,
						invokedArnInfo.modelType,
					)
					if (invokedModel) {
						invokedModel.id = modelConfig.id
						handler.costModelConfig = invokedModel
					}

					// Handle metadata events for the promptRouter.
					if (streamEvent?.trace?.promptRouter?.usage) {
						const routerUsage = streamEvent.trace.promptRouter.usage

						// Check both field naming conventions for cache tokens
						const cacheReadTokens = routerUsage.cacheReadTokens || routerUsage.cacheReadInputTokenCount || 0
						const cacheWriteTokens =
							routerUsage.cacheWriteTokens || routerUsage.cacheWriteInputTokenCount || 0

						yield {
							type: "usage",
							inputTokens: routerUsage.inputTokens || 0,
							outputTokens: routerUsage.outputTokens || 0,
							cacheReadTokens: cacheReadTokens,
							cacheWriteTokens: cacheWriteTokens,
						}
					}
				} catch (error) {
					logger.error("Error handling Bedrock invokedModelId", {
						ctx: "bedrock",
						error: error instanceof Error ? error : String(error),
					})
				}
				continue
			}

			// Handle message start
			if (streamEvent.messageStart) {
				continue
			}

			// Handle content blocks
			if (streamEvent.contentBlockStart) {
				const cbStart = streamEvent.contentBlockStart

				// Check if this is a reasoning block (AWS SDK structure)
				if (cbStart.contentBlock?.reasoningContent) {
					if (cbStart.contentBlockIndex && cbStart.contentBlockIndex > 0) {
						yield { type: "reasoning", text: "\n" }
					}
					yield {
						type: "reasoning",
						text: cbStart.contentBlock.reasoningContent.text || "",
					}
				}
				// Check for thinking block - handle both possible AWS SDK structures
				// cbStart.contentBlock: newer structure
				// cbStart.content_block: alternative structure seen in some AWS SDK versions
				else if (cbStart.contentBlock?.type === "thinking" || cbStart.content_block?.type === "thinking") {
					const contentBlock = cbStart.contentBlock || cbStart.content_block
					if (cbStart.contentBlockIndex && cbStart.contentBlockIndex > 0) {
						yield { type: "reasoning", text: "\n" }
					}
					if (contentBlock?.thinking) {
						yield {
							type: "reasoning",
							text: contentBlock.thinking,
						}
					}
				}
				// Handle tool use block start
				else if (cbStart.start?.toolUse || cbStart.contentBlock?.toolUse) {
					const toolUse = cbStart.start?.toolUse || cbStart.contentBlock?.toolUse
					if (toolUse) {
						yield {
							type: "tool_call_partial",
							index: cbStart.contentBlockIndex ?? 0,
							id: toolUse.toolUseId,
							name: toolUse.name,
							arguments: undefined,
						}
					}
				} else if (cbStart.start?.text) {
					yield {
						type: "text",
						text: cbStart.start.text,
					}
				}
				continue
			}

			// Handle content deltas
			if (streamEvent.contentBlockDelta) {
				const cbDelta = streamEvent.contentBlockDelta
				const delta = cbDelta.delta

				// Process reasoning and text content deltas
				// Multiple structures are supported for AWS SDK compatibility:
				// - delta.reasoningContent.text: AWS docs structure for reasoning
				// - delta.thinking: alternative structure for thinking content
				// - delta.text: standard text content
				// - delta.toolUse.input: tool input arguments
				if (delta) {
					// Check for reasoningContent property (AWS SDK structure)
					if (delta.reasoningContent?.text) {
						yield {
							type: "reasoning",
							text: delta.reasoningContent.text,
						}
						continue
					}

					// Handle tool use input delta
					if (delta.toolUse?.input) {
						yield {
							type: "tool_call_partial",
							index: cbDelta.contentBlockIndex ?? 0,
							id: undefined,
							name: undefined,
							arguments: delta.toolUse.input,
						}
						continue
					}

					// Handle alternative thinking structure (fallback for older SDK versions)
					if (delta.type === "thinking_delta" && delta.thinking) {
						yield {
							type: "reasoning",
							text: delta.thinking,
						}
					} else if (delta.text) {
						yield {
							type: "text",
							text: delta.text,
						}
					}
				}
				continue
			}
			// Handle message stop
			if (streamEvent.messageStop) {
				continue
			}
		}
		// Clear timeout after stream completes
		clearTimeout(timeoutId)
	} catch (error: UnsafeAny) {
		// Clear timeout on error
		clearTimeout(timeoutId)

		// Check if this is a throttling error that should trigger retry logic
		const errorType = handler.getErrorType(error)

		// For throttling errors, throw immediately without yielding chunks
		// This allows the retry mechanism in attemptApiRequest() to catch and handle it
		// The retry logic in Task.ts (around line 1817) expects errors to be thrown
		// on the first chunk for proper exponential backoff behavior
		if (errorType === "THROTTLING") {
			const errorMessage = handler.formatErrorMessage(error, errorType, true)
			throw handler.createEnhancedProviderError(error, errorMessage, "createMessage")
		}

		// For non-throttling errors in streaming context, yield error chunk and return
		// (don't throw - caller is already iterating the stream)
		const errorChunks = handler.handleBedrockError(error, true) // true for streaming context
		// Yield each chunk individually to ensure type compatibility
		for (const chunk of errorChunks) {
			yield chunk as UnsafeAny // Cast to any to bypass type checking since we know the structure is correct
		}

		// Throw enhanced error so stream failures still trigger retry/backoff logic upstream.
		const enhancedErrorMessage = handler.formatErrorMessage(error, errorType, true)
		throw handler.createEnhancedProviderError(error, enhancedErrorMessage, "createMessage")
	}
}

/**
 * Convert Anthropic messages to Bedrock Converse format
 */
export function bedrockConvertToBedrockConverseMessages(
	handler: BedrockConverseHandler,
	anthropicMessages: Anthropic.Messages.MessageParam[] | { role: string; content: string }[],
	systemMessage?: string,
	usePromptCache: boolean = false,
	modelInfo?: UnsafeAny,
	conversationId?: string, // Optional conversation ID to track cache points across messages
): { system: SystemContentBlock[]; messages: Message[] } {
	// First convert messages using shared converter for proper image handling
	const convertedMessages = sharedConverter(anthropicMessages as Anthropic.Messages.MessageParam[])

	// If prompt caching is disabled, return the converted messages directly
	if (!usePromptCache) {
		return {
			system: systemMessage ? [{ text: systemMessage } as SystemContentBlock] : [],
			messages: convertedMessages,
		}
	}

	// Convert model info to expected format for cache strategy
	const cacheModelInfo: CacheModelInfo = {
		maxTokens: modelInfo?.maxTokens || 8192,
		contextWindow: modelInfo?.contextWindow || 200_000,
		supportsPromptCache: modelInfo?.supportsPromptCache || false,
		maxCachePoints: modelInfo?.maxCachePoints || 0,
		minTokensPerCachePoint: modelInfo?.minTokensPerCachePoint || 50,
		cachableFields: modelInfo?.cachableFields || [],
	}

	// Get previous cache point placements for this conversation if available
	const previousPlacements =
		conversationId && handler.previousCachePointPlacements[conversationId]
			? handler.previousCachePointPlacements[conversationId]
			: undefined

	// Create config for cache strategy
	const config = {
		modelInfo: cacheModelInfo,
		systemPrompt: systemMessage,
		messages: anthropicMessages as Anthropic.Messages.MessageParam[],
		usePromptCache,
		previousCachePointPlacements: previousPlacements,
	}

	// Get cache point placements
	const strategy = new MultiPointStrategy(config)
	const cacheResult = strategy.determineOptimalCachePoints()

	// Store cache point placements for future use if conversation ID is provided
	if (conversationId && cacheResult.messageCachePointPlacements) {
		handler.previousCachePointPlacements[conversationId] = cacheResult.messageCachePointPlacements
	}

	// Apply cache points to the properly converted messages
	const messagesWithCache = convertedMessages.map((msg, index) => {
		const placement = cacheResult.messageCachePointPlacements?.find((p) => p.index === index)
		if (placement) {
			return {
				...msg,
				content: [...(msg.content || []), { cachePoint: { type: "default" } } as ContentBlock],
			}
		}
		return msg
	})

	return {
		system: cacheResult.system,
		messages: messagesWithCache,
	}
}
