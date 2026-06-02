import * as os from "os"
import { v7 as uuidv7 } from "uuid"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { z } from "zod"

import { Package } from "../../../shared/package"
import {
	type ModelInfo,
	ApiProviderError,
	type VerbosityLevel,
	type ReasoningEffortExtended,
	type ServiceTier,
} from "@njust-ai/types"
import {
	openAiNativeDefaultModelId,
	OpenAiNativeModelId,
	openAiNativeModels,
	OPENAI_NATIVE_DEFAULT_TEMPERATURE,
} from "@njust-ai/core/providers"
import { TelemetryService } from "@njust-ai/telemetry"

import type { ApiHandlerOptions } from "../../../shared/api"
import { calculateApiCostOpenAI, resolveOpenAiUsageForCost } from "../../../shared/cost"
import { ApiStreamUsageChunk } from "../../transform/stream"
import { getModelParams } from "../../transform/model-params"
import { BaseProvider } from "../base-provider"
import type { SingleCompletionHandler } from "../../types"
import { requireApiKey } from "../../interfaces/api-key-validator"
import { getErrorMessage } from "../../../shared/error-utils"

export type OpenAiNativeModel = ReturnType<OpenAiNativeHandlerBase["getModel"]>

export type ResponsesInputItem =
	| { role: "user" | "assistant"; content: Record<string, UnsafeAny>[] }
	| { type: string; id?: string; encrypted_content?: string; [key: string]: UnsafeAny }
	| Anthropic.Messages.MessageParam

export interface ResponsesOutputItem {
	type?: string
	text?: UnsafeAny
	output_text?: string
	delta?: string
	content?: ResponsesOutputItem[]
	call_id?: string
	tool_call_id?: string
	id?: string
	name?: string
	function_name?: string
	function?: { name?: string; arguments?: UnsafeAny }
	arguments?: UnsafeAny
	input?: UnsafeAny
	encrypted_content?: string
	[key: string]: UnsafeAny
}

export interface ResponsesStreamEvent {
	type?: string
	response?: {
		service_tier?: ServiceTier
		output?: ResponsesOutputItem[]
		id?: string
		usage?: OpenAiUsageData
	}
	delta?: string
	text?: string
	output_text?: string
	part?: ResponsesOutputItem
	item?: ResponsesOutputItem
	call_id?: string
	tool_call_id?: string
	id?: string
	name?: string
	function_name?: string
	arguments?: UnsafeAny
	index?: number
	choices?: Array<{ delta?: { content?: string } }>
	usage?: OpenAiUsageData
	[key: string]: UnsafeAny
}

export interface ResponsesClientLike {
	responses: {
		create(
			body: ResponsesRequestBody,
			options?: { signal?: AbortSignal; headers?: Record<string, string> },
		): Promise<AsyncIterable<ResponsesStreamEvent>>
	}
}

/** Non-streaming response shape used in completePrompt */
interface NonStreamingResponsesClient {
	responses: {
		create(
			body: ResponsesRequestBody,
			options?: { signal?: AbortSignal; headers?: Record<string, string> },
		): Promise<{ output?: ResponsesOutputItem[]; text?: UnsafeAny }>
	}
}

export interface ResponsesRequestBody {
	model: string
	input: ResponsesInputItem[]
	stream: boolean
	reasoning?: { effort?: ReasoningEffortExtended; summary?: "auto" }
	text?: { verbosity: VerbosityLevel }
	temperature?: number
	max_output_tokens?: number
	store?: boolean
	instructions?: string
	service_tier?: ServiceTier
	include?: string[]
	prompt_cache_retention?: "in_memory" | "24h"
	tools?: Array<{
		type: "function"
		name: string
		description?: string
		parameters?: Record<string, unknown>
		strict?: boolean
	}>
	tool_choice?: OpenAI.Chat.ChatCompletionCreateParams["tool_choice"]
	parallel_tool_calls?: boolean
}

export interface OpenAiUsageData {
	input_tokens?: number
	prompt_tokens?: number
	output_tokens?: number
	completion_tokens?: number
	cache_creation_input_tokens?: number
	cache_write_tokens?: number
	cache_read_input_tokens?: number
	cache_read_tokens?: number
	cached_tokens?: number
	input_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number }
	prompt_tokens_details?: { cached_tokens?: number; cache_miss_tokens?: number }
	output_tokens_details?: { reasoning_tokens?: number }
}

export const openAiErrorResponseSchema = z
	.object({
		error: z
			.object({
				message: z.string().optional(),
			})
			.passthrough()
			.optional(),
		message: z.string().optional(),
	})
	.passthrough()

export const openAiResponsesStreamEventSchema = z.object({}).passthrough()

export type Constructor<T = object> = new (...args: unknown[]) => T

export abstract class OpenAiNativeHandlerBase extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	client: OpenAI
	readonly providerName = "OpenAI Native"
	readonly sessionId: string
	pendingToolCallId: string | undefined
	pendingToolCallName: string | undefined
	sawTextOutputInCurrentResponse = false
	sawTextDeltaInCurrentResponse = false
	streamedToolCallIds = new Set<string>()
	lastServiceTier: ServiceTier | undefined
	lastResponseOutput: ResponsesOutputItem[] | undefined
	lastResponseId: string | undefined
	abortController?: AbortController

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.sessionId = uuidv7()
		if (this.options.enableResponsesReasoningSummary === undefined) {
			this.options.enableResponsesReasoningSummary = true
		}
		const apiKey = requireApiKey(this.options.openAiNativeApiKey, "OpenAI Native")
		const userAgent = `Njust-AI/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`
		this.client = new OpenAI({
			baseURL: this.options.openAiNativeBaseUrl || undefined,
			apiKey,
			defaultHeaders: {
				originator: "Njust-AI",
				session_id: this.sessionId,
				"User-Agent": userAgent,
			},
		})
	}

	// Abstract methods provided by reasoning mixin
	abstract getReasoningEffort(model: OpenAiNativeModel): ReasoningEffortExtended | undefined
	abstract getPromptCacheRetention(model: OpenAiNativeModel): "24h" | undefined
	abstract applyServiceTierPricing(info: ModelInfo, tier?: ServiceTier): ModelInfo

	normalizeUsage(usage: OpenAiUsageData | undefined, model: OpenAiNativeModel): ApiStreamUsageChunk | undefined {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details
		const cachedFromDetails = inputDetails?.cached_tokens ?? 0
		const missFromDetails = inputDetails?.cache_miss_tokens ?? 0

		let totalInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		if (totalInputTokens === 0 && inputDetails && (cachedFromDetails > 0 || missFromDetails > 0)) {
			totalInputTokens = cachedFromDetails + missFromDetails
		}

		const totalOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0
		const cacheReadTokens =
			usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cached_tokens ?? cachedFromDetails ?? 0

		const effectiveTier =
			this.lastServiceTier || (this.options.openAiNativeServiceTier as ServiceTier | undefined) || undefined
		const effectiveInfo = this.applyServiceTierPricing(model.info, effectiveTier)

		const detailMiss =
			typeof inputDetails?.cache_miss_tokens === "number" ? inputDetails.cache_miss_tokens : undefined
		const detailCached = typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : undefined

		const resolved = resolveOpenAiUsageForCost({
			inputTokensReported: totalInputTokens,
			cacheWriteTokens: cacheWriteTokens,
			cacheReadTokens: cacheReadTokens,
			cacheMissTokensFromDetails: detailMiss,
			cachedTokensFromDetails: detailCached,
		})

		const costResult = calculateApiCostOpenAI(
			effectiveInfo,
			resolved.totalInputTokens,
			totalOutputTokens,
			resolved.cacheWriteTokens,
			resolved.cacheReadTokens,
			{ serviceTier: effectiveTier },
		)

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: costResult.totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheWriteTokens: resolved.cacheWriteTokens,
			cacheReadTokens: resolved.cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: costResult.totalCost,
		}
		return out
	}

	override getModel() {
		const modelId = this.options.apiModelId
		const id =
			modelId && modelId in openAiNativeModels ? (modelId as OpenAiNativeModelId) : openAiNativeDefaultModelId
		const info: ModelInfo = openAiNativeModels[id]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: OPENAI_NATIVE_DEFAULT_TEMPERATURE,
		})
		return { id: id.startsWith("o3-mini") ? "o3-mini" : id, info, ...params, verbosity: params.verbosity }
	}

	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		if (!this.lastResponseOutput) return undefined
		const reasoningItem = this.lastResponseOutput.find(
			(item) => item.type === "reasoning" && item.encrypted_content,
		)
		if (!reasoningItem?.encrypted_content) return undefined
		return {
			encrypted_content: reasoningItem.encrypted_content as string,
			...(reasoningItem.id ? { id: reasoningItem.id as string } : {}),
		}
	}

	getResponseId(): string | undefined {
		return this.lastResponseId
	}

	async completePrompt(prompt: string): Promise<string> {
		this.abortController = new AbortController()
		try {
			const model = this.getModel()
			const { verbosity } = model
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

			const requestedTier = (this.options.openAiNativeServiceTier as ServiceTier | undefined) || undefined
			const allowedTierNames = new Set(model.info.tiers?.map((t) => t.name).filter(Boolean) || [])
			if (requestedTier && (requestedTier === "default" || allowedTierNames.has(requestedTier))) {
				requestBody.service_tier = requestedTier
			}

			if (reasoningEffort) {
				requestBody.reasoning = {
					effort: reasoningEffort,
					...(this.options.enableResponsesReasoningSummary ? { summary: "auto" as const } : {}),
				}
			}

			if (model.info.supportsTemperature !== false) {
				requestBody.temperature = this.options.modelTemperature ?? OPENAI_NATIVE_DEFAULT_TEMPERATURE
			}

			if (model.maxTokens) {
				requestBody.max_output_tokens = model.maxTokens
			}

			if (model.info.supportsVerbosity === true) {
				requestBody.text = { verbosity: (verbosity || "medium") as VerbosityLevel }
			}

			const promptCacheRetention = this.getPromptCacheRetention(model)
			if (promptCacheRetention) {
				requestBody.prompt_cache_retention = promptCacheRetention
			}

			const response = await (this.client as unknown as NonStreamingResponsesClient).responses.create(
				requestBody,
				{
					signal: this.abortController.signal,
				},
			)

			if (response?.output && Array.isArray(response.output)) {
				for (const outputItem of response.output) {
					if (outputItem.type === "message" && outputItem.content) {
						for (const content of outputItem.content) {
							if (content.type === "output_text" && content.text) {
								return content.text
							}
						}
					}
				}
			}

			if (response?.text) {
				return response.text
			}

			return ""
		} catch (error) {
			if (TelemetryService.hasInstance()) {
				const msg = getErrorMessage(error)
				const forTelemetry = new ApiProviderError(msg)
				forTelemetry.provider = this.providerName
				forTelemetry.modelId = this.getModel().id
				forTelemetry.operation = "completePrompt"
				TelemetryService.instance.captureException(forTelemetry)
			}
			if (error instanceof Error) {
				throw new ApiProviderError(`OpenAI Native completion error: ${error.message}`)
			}
			throw error instanceof ApiProviderError ? error : new ApiProviderError(String(error), { cause: error })
		} finally {
			this.abortController = undefined
		}
	}
}
