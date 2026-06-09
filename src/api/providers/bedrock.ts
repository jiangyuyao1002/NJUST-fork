import {
	BedrockRuntimeClient,
	ConverseCommand,
	BedrockRuntimeClientConfig,
	Message,
	SystemContentBlock,
} from "@aws-sdk/client-bedrock-runtime"
import { fromIni } from "@aws-sdk/credential-providers"
import { Anthropic } from "@anthropic-ai/sdk"

import { type ModelInfo, type ProviderSettings, ApiProviderError } from "@njust-ai/types"
import {
	type BedrockModelId,
	bedrockDefaultModelId,
	bedrockModels,
	bedrockDefaultPromptRouterModelId,
	BEDROCK_DEFAULT_TEMPERATURE,
	BEDROCK_MAX_TOKENS,
	BEDROCK_DEFAULT_CONTEXT,
	BEDROCK_1M_CONTEXT_MODEL_IDS,
	BEDROCK_GLOBAL_INFERENCE_MODEL_IDS,
	BEDROCK_SERVICE_TIER_MODEL_IDS,
	BEDROCK_SERVICE_TIER_PRICING,
} from "@njust-ai/core/providers"
import { TelemetryService } from "@njust-ai/telemetry"

import { ApiStream } from "../transform/stream"
import { BaseProvider } from "./base-provider"
import { logger } from "../../utils/logging"
import { Package } from "../../shared/package"
import { getModelParams } from "../transform/model-params"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../types"
import { getErrorMessage } from "../../shared/error-utils"
import { type BedrockInferenceConfig, isBedrockError } from "./bedrock-types"
import {
	getBedrockErrorType,
	formatBedrockErrorMessage,
	handleBedrockError as handleBedrockErrorImpl,
} from "./bedrock-errors"
import {
	bedrockParseArn as parseArnImpl,
	bedrockParseBaseModelId as parseBaseModelIdImpl,
	getPrefixForRegion as getPrefixForRegionImpl,
	isSystemInferenceProfile as isSystemInferenceProfileImpl,
} from "./bedrock-models"
import { bedrockCreateMessageInner, bedrockConvertToBedrockConverseMessages } from "./bedrock-converse"

export type { StreamEvent, UsageType } from "./bedrock-types"

/************************************************************************************
 *
 *     TYPES
 *
 *************************************************************************************/

/************************************************************************************
 *
 *     PROVIDER
 *
 *************************************************************************************/

export class AwsBedrockHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ProviderSettings
	private client: BedrockRuntimeClient
	private arnInfo: {
		isValid: boolean
		region?: string
		modelType?: string
		modelId?: string
		errorMessage?: string
		crossRegionInference: boolean
	} = { isValid: false, crossRegionInference: false }
	private readonly providerName = "Bedrock"

	constructor(options: ProviderSettings) {
		super()
		this.options = options
		const region = this.options.awsRegion

		// process the various user input options, be opinionated about the intent of the options
		// and determine the model to use during inference and for cost calculations
		// There are variations on ARN strings that can be entered making the conditional logic
		// more involved than the non-ARN branch of logic
		if (this.options.awsCustomArn) {
			this.arnInfo = this.parseArn(this.options.awsCustomArn, region)

			if (!this.arnInfo.isValid) {
				logger.error("Invalid ARN format", {
					ctx: "bedrock",
					errorMessage: this.arnInfo.errorMessage,
				})

				// Throw a consistent error with a prefix that can be detected by callers
				const errorMessage =
					this.arnInfo.errorMessage ||
					"Invalid ARN format. ARN should follow the pattern: arn:aws:bedrock:region:account-id:resource-type/resource-name"
				throw new Error("INVALID_ARN_FORMAT:" + errorMessage)
			}

			if (this.arnInfo.region && this.arnInfo.region !== this.options.awsRegion) {
				// Log a warning if there's a region mismatch between the ARN and the region selected by the user.
				// We will use the ARN's region, so execution can continue.
				logger.info(this.arnInfo.errorMessage ?? "Region mismatch between ARN and selected region", {
					ctx: "bedrock",
					selectedRegion: this.options.awsRegion,
					arnRegion: this.arnInfo.region,
				})

				this.options.awsRegion = this.arnInfo.region
			}

			this.options.apiModelId = this.arnInfo.modelId
			if (this.arnInfo.crossRegionInference) this.options.awsUseCrossRegionInference = true
		}

		if (!this.options.modelTemperature) {
			this.options.modelTemperature = BEDROCK_DEFAULT_TEMPERATURE
		}

		this.costModelConfig = this.getModel()

		const clientConfig: BedrockRuntimeClientConfig = {
			userAgentAppId: `NJUST_AI#${Package.version}`,
			region: this.options.awsRegion,
			// Add the endpoint configuration when specified and enabled
			...(this.options.awsBedrockEndpoint &&
				this.options.awsBedrockEndpointEnabled && { endpoint: this.options.awsBedrockEndpoint }),
		}

		if (this.options.awsUseApiKey && this.options.awsApiKey) {
			// Use API key/token-based authentication if enabled and API key is set
			clientConfig.token = { token: this.options.awsApiKey }
			clientConfig.authSchemePreference = ["httpBearerAuth"] // Otherwise there's no end of credential problems.
			clientConfig.requestHandler = {
				// This should be the default anyway, but without setting something
				// this provider fails to work with LiteLLM passthrough.
				requestTimeout: 0,
			}
		} else if (this.options.awsUseProfile && this.options.awsProfile) {
			// Use profile-based credentials if enabled and profile is set
			clientConfig.credentials = fromIni({
				profile: this.options.awsProfile,
				ignoreCache: true,
			})
		} else if (this.options.awsAccessKey && this.options.awsSecretKey) {
			// Use direct credentials if provided
			clientConfig.credentials = {
				accessKeyId: this.options.awsAccessKey,
				secretAccessKey: this.options.awsSecretKey,
				...(this.options.awsSessionToken ? { sessionToken: this.options.awsSessionToken } : {}),
			}
		}

		this.client = new BedrockRuntimeClient(clientConfig)
	}

	private guessModelInfoFromId(modelId: string): Partial<ModelInfo> {
		// Define a mapping for model ID patterns and their configurations
		const modelConfigMap: Record<string, Partial<ModelInfo>> = {
			"claude-4": {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
			"claude-3-7": {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
			"claude-3-5": {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
			"claude-4-opus": {
				maxTokens: 4096,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
			"claude-3-opus": {
				maxTokens: 4096,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
			"claude-3-haiku": {
				maxTokens: 4096,
				contextWindow: 200_000,
				supportsImages: true,
				supportsPromptCache: true,
			},
		}

		// Match the model ID to a configuration
		const id = modelId.toLowerCase()
		for (const [pattern, config] of Object.entries(modelConfigMap)) {
			if (id.includes(pattern)) {
				return config
			}
		}

		// Default fallback
		return {
			maxTokens: BEDROCK_MAX_TOKENS,
			contextWindow: BEDROCK_DEFAULT_CONTEXT,
			supportsImages: false,
			supportsPromptCache: false,
		}
	}

	override async *createMessage(
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
		yield* this.guardEmptyStream(this.createMessageInner(systemPrompt, messages, metadata))
	}

	protected async *createMessageInner(
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
		yield* bedrockCreateMessageInner(this, systemPrompt, messages, metadata)
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const modelConfig = this.getModel()
			const isBedrockClaudeOpus47 = this.parseBaseModelId(modelConfig.id) === "anthropic.claude-opus-4-7"

			const inferenceConfig: BedrockInferenceConfig = {
				maxTokens: modelConfig.maxTokens || (modelConfig.info.maxTokens as number),
				...(!isBedrockClaudeOpus47 && {
					temperature: modelConfig.temperature ?? (this.options.modelTemperature as number),
				}),
			}

			// For completePrompt, use a unique conversation ID based on the prompt
			const conversationId = `prompt_${prompt.substring(0, 20)}`

			const payload = {
				modelId: modelConfig.id,
				messages: bedrockConvertToBedrockConverseMessages(
					this,
					[
						{
							role: "user",
							content: prompt,
						},
					],
					undefined,
					false,
					modelConfig.info,
					conversationId,
				).messages,
				inferenceConfig,
			}

			const command = new ConverseCommand(payload)
			const response = await this.client.send(command)

			if (
				response?.output?.message?.content &&
				response.output.message.content.length > 0 &&
				response.output.message.content[0]!.text &&
				response.output.message.content[0]!.text.trim().length > 0
			) {
				try {
					return response.output.message.content[0]!.text
				} catch (parseError) {
					logger.error("Failed to parse Bedrock response", {
						ctx: "bedrock",
						error: parseError instanceof Error ? parseError : String(parseError),
					})
				}
			}
			return ""
		} catch (error) {
			// Use the extracted error handling method for all errors
			const errorResult = this.handleBedrockError(error, false) // false for non-streaming context
			// Since we're in a non-streaming context, we know the result is a string
			const errorMessage = errorResult as string
			throw this.createEnhancedProviderError(error, errorMessage, "completePrompt")
		}
	}

	private createEnhancedProviderError(
		error: UnsafeAny,
		errorMessage: string,
		operation: "createMessage" | "completePrompt",
	): ApiProviderError {
		const modelId = this.getModel().id
		if (TelemetryService.hasInstance()) {
			const origMsg = getErrorMessage(error)
			const forTelemetry = new ApiProviderError(origMsg)
			forTelemetry.provider = this.providerName
			forTelemetry.modelId = modelId
			forTelemetry.operation = operation
			TelemetryService.instance.captureException(forTelemetry)
		}

		const enhancedError = new ApiProviderError(errorMessage)
		if (error instanceof Error) {
			enhancedError.name = error.name
			if (isBedrockError(error) && typeof error.status === "number") {
				enhancedError.status = error.status
			}
			if (isBedrockError(error) && typeof error.$metadata === "object" && error.$metadata !== null) {
				enhancedError.$metadata = error.$metadata
			}
		}
		return enhancedError
	}

	/**
	 * Convert Anthropic messages to Bedrock Converse format
	 */
	private convertToBedrockConverseMessages(
		anthropicMessages: Anthropic.Messages.MessageParam[] | { role: string; content: string }[],
		systemMessage?: string,
		usePromptCache: boolean = false,
		modelInfo?: UnsafeAny,
		conversationId?: string, // Optional conversation ID to track cache points across messages
	): { system: SystemContentBlock[]; messages: Message[] } {
		return bedrockConvertToBedrockConverseMessages(
			this,
			anthropicMessages,
			systemMessage,
			usePromptCache,
			modelInfo,
			conversationId,
		)
	}

	/************************************************************************************
	 *
	 *     MODEL IDENTIFICATION
	 *
	 *************************************************************************************/

	private costModelConfig: { id: BedrockModelId | string; info: ModelInfo } = {
		id: "",
		info: { maxTokens: 0, contextWindow: 0, supportsPromptCache: false, supportsImages: false },
	}

	private parseArn(arn: string, region?: string) {
		return parseArnImpl(arn, region)
	}

	//This strips any region prefix that used on cross-region model inference ARNs
	private parseBaseModelId(modelId: string): string {
		return parseBaseModelIdImpl(modelId)
	}

	//Prompt Router responses come back in a different sequence and the model used is in the response and must be fetched by name
	getModelById(modelId: string, modelType?: string): { id: BedrockModelId | string; info: ModelInfo } {
		// Try to find the model in bedrockModels
		const baseModelId = this.parseBaseModelId(modelId) as BedrockModelId

		let model
		if (baseModelId in bedrockModels) {
			//Do a deep copy of the model info so that later in the code the model id and maxTokens can be set.
			// The bedrockModels array is a constant and updating the model ID from the returned invokedModelID value
			// in a prompt router response isn't possible on the constant.
			model = { id: baseModelId, info: JSON.parse(JSON.stringify(bedrockModels[baseModelId])) }
		} else if (modelType?.includes("router")) {
			model = {
				id: bedrockDefaultPromptRouterModelId,
				info: JSON.parse(JSON.stringify(bedrockModels[bedrockDefaultPromptRouterModelId])),
			}
		} else {
			// Use heuristics for model info, then allow overrides from ProviderSettings
			const guessed = this.guessModelInfoFromId(modelId)
			model = {
				id: bedrockDefaultModelId,
				info: {
					...JSON.parse(JSON.stringify(bedrockModels[bedrockDefaultModelId])),
					...guessed,
				},
			}
		}

		// Always allow user to override detected/guessed maxTokens and contextWindow
		if (this.options.modelMaxTokens && this.options.modelMaxTokens > 0) {
			model.info.maxTokens = this.options.modelMaxTokens
		}
		if (this.options.awsModelContextWindow && this.options.awsModelContextWindow > 0) {
			model.info.contextWindow = this.options.awsModelContextWindow
		}

		return model
	}

	override getModel(): {
		id: BedrockModelId | string
		info: ModelInfo
		maxTokens?: number
		temperature?: number
		reasoning?: UnsafeAny
		reasoningBudget?: number
	} {
		if (this.costModelConfig?.id?.trim().length > 0) {
			// Get model params for cost model config
			const params = getModelParams({
				format: "anthropic",
				modelId: this.costModelConfig.id,
				model: this.costModelConfig.info,
				settings: this.options,
				defaultTemperature: BEDROCK_DEFAULT_TEMPERATURE,
			})
			return { ...this.costModelConfig, ...params }
		}

		let modelConfig = undefined

		// If custom ARN is provided, use it
		if (this.options.awsCustomArn) {
			modelConfig = this.getModelById(this.arnInfo.modelId!, this.arnInfo.modelType)

			//If the user entered an ARN for a foundation-model they've done the same thing as picking from our list of options.
			//We leave the model data matching the same as if a drop-down input method was used by not overwriting the model ID with the user input ARN
			//Otherwise the ARN is not a foundation-model resource type that ARN should be used as the identifier in Bedrock interactions
			if (this.arnInfo.modelType !== "foundation-model") modelConfig.id = this.options.awsCustomArn
		} else {
			//a model was selected from the drop down
			modelConfig = this.getModelById(this.options.apiModelId as string)

			// Apply Global Inference prefix if enabled and supported (takes precedence over cross-region)
			const baseIdForGlobal = this.parseBaseModelId(modelConfig.id)
			if (
				this.options.awsUseGlobalInference &&
				(BEDROCK_GLOBAL_INFERENCE_MODEL_IDS as readonly string[]).includes(baseIdForGlobal)
			) {
				modelConfig.id = `global.${baseIdForGlobal}`
			}
			// Otherwise, add cross-region inference prefix if enabled
			else if (this.options.awsUseCrossRegionInference && this.options.awsRegion) {
				const prefix = AwsBedrockHandler.getPrefixForRegion(this.options.awsRegion)
				if (prefix) {
					modelConfig.id = `${prefix}${modelConfig.id}`
				}
			}
		}

		// Check if 1M context is enabled for supported Claude 4 models
		// Use parseBaseModelId to handle cross-region inference prefixes
		const baseModelId = this.parseBaseModelId(modelConfig.id)
		if (
			(BEDROCK_1M_CONTEXT_MODEL_IDS as readonly string[]).includes(baseModelId) &&
			this.options.awsBedrock1MContext
		) {
			// Update context window and pricing to 1M tier when 1M context beta is enabled
			const tier = modelConfig.info.tiers?.[0]
			modelConfig.info = {
				...modelConfig.info,
				contextWindow: tier?.contextWindow ?? 1_000_000,
				inputPrice: tier?.inputPrice ?? modelConfig.info.inputPrice,
				outputPrice: tier?.outputPrice ?? modelConfig.info.outputPrice,
				cacheWritesPrice: tier?.cacheWritesPrice ?? modelConfig.info.cacheWritesPrice,
				cacheReadsPrice: tier?.cacheReadsPrice ?? modelConfig.info.cacheReadsPrice,
			}
		}

		// Get model params including reasoning configuration
		const params = getModelParams({
			format: "anthropic",
			modelId: modelConfig.id,
			model: modelConfig.info,
			settings: this.options,
			defaultTemperature: BEDROCK_DEFAULT_TEMPERATURE,
		})

		// Apply service tier pricing if specified and model supports it
		const baseModelIdForTier = this.parseBaseModelId(modelConfig.id)
		if (
			this.options.awsBedrockServiceTier &&
			(BEDROCK_SERVICE_TIER_MODEL_IDS as readonly string[]).includes(baseModelIdForTier)
		) {
			const pricingMultiplier = BEDROCK_SERVICE_TIER_PRICING[this.options.awsBedrockServiceTier]
			if (pricingMultiplier && pricingMultiplier !== 1.0) {
				// Apply pricing multiplier to all price fields
				modelConfig.info = {
					...modelConfig.info,
					inputPrice: modelConfig.info.inputPrice
						? modelConfig.info.inputPrice * pricingMultiplier
						: undefined,
					outputPrice: modelConfig.info.outputPrice
						? modelConfig.info.outputPrice * pricingMultiplier
						: undefined,
					cacheWritesPrice: modelConfig.info.cacheWritesPrice
						? modelConfig.info.cacheWritesPrice * pricingMultiplier
						: undefined,
					cacheReadsPrice: modelConfig.info.cacheReadsPrice
						? modelConfig.info.cacheReadsPrice * pricingMultiplier
						: undefined,
				}
			}
		}

		// Don't override maxTokens/contextWindow here; handled in getModelById (and includes user overrides)
		return { ...modelConfig, ...params } as {
			id: BedrockModelId | string
			info: ModelInfo
			maxTokens?: number
			temperature?: number
			reasoning?: UnsafeAny
			reasoningBudget?: number
		}
	}

	/************************************************************************************
	 *
	 *     CACHE
	 *
	 *************************************************************************************/

	// Store previous cache point placements for maintaining consistency across consecutive messages
	private previousCachePointPlacements: { [conversationId: string]: UnsafeAny[] } = {}

	private supportsAwsPromptCache(modelConfig: { id: BedrockModelId | string; info: ModelInfo }): boolean | undefined {
		// Check if the model supports prompt cache
		// The cachableFields property is not part of the ModelInfo type in schemas
		// but it's used in the bedrockModels object in shared/api.ts
		return (
			modelConfig?.info?.supportsPromptCache &&
			// Use optional chaining and type assertion to access cachableFields
			modelConfig?.info?.cachableFields &&
			modelConfig?.info?.cachableFields?.length > 0
		)
	}

	/************************************************************************************
	 *
	 *     NATIVE TOOLS
	 *
	 *************************************************************************************/

	/************************************************************************************
	 *
	 *     AMAZON REGIONS
	 *
	 *************************************************************************************/

	private static getPrefixForRegion(region: string): string | undefined {
		return getPrefixForRegionImpl(region)
	}

	private static isSystemInferenceProfile(prefix: string): boolean {
		return isSystemInferenceProfileImpl(prefix)
	}

	/************************************************************************************
	 *
	 *     ERROR HANDLING
	 *
	 *************************************************************************************/

	/**
	 * Determines the error type based on the error message or name
	 */
	private getErrorType(error: UnsafeAny): string {
		return getBedrockErrorType(error)
	}

	/**
	 * Formats an error message based on the error type and context
	 */
	private formatErrorMessage(error: UnsafeAny, errorType: string, _isStreamContext: boolean): string {
		const modelConfig = this.getModel()
		const region =
			typeof this?.client?.config?.region === "function"
				? this?.client?.config?.region()
				: this?.client?.config?.region
		return formatBedrockErrorMessage(error, errorType, _isStreamContext, modelConfig, region)
	}

	/**
	 * Handles Bedrock API errors and generates appropriate error messages
	 * @param error The error that occurred
	 * @param isStreamContext Whether the error occurred in a streaming context (true) or not (false)
	 * @returns Error message string for non-streaming context or array of stream chunks for streaming context
	 */
	private handleBedrockError(
		error: UnsafeAny,
		isStreamContext: boolean,
	): string | Array<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }> {
		const modelConfig = this.getModel()
		const region =
			typeof this?.client?.config?.region === "function"
				? this?.client?.config?.region()
				: this?.client?.config?.region
		return handleBedrockErrorImpl(
			error,
			isStreamContext,
			this.options.awsCustomArn,
			region,
			modelConfig,
			this.client,
		)
	}
}
