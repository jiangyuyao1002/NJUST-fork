import {
	mimoTokenPlanModels,
	mimoTokenPlanDefaultModelId,
	MIMO_TOKEN_PLAN_DEFAULT_TEMPERATURE,
} from "@njust-ai/core/providers"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAICompatibleHandler, type OpenAICompatibleConfig } from "./openai-compatible"
import { requireApiKey } from "../interfaces/api-key-validator"

export class MimoTokenPlanHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? mimoTokenPlanDefaultModelId
		const modelInfo =
			mimoTokenPlanModels[modelId as keyof typeof mimoTokenPlanModels] ||
			mimoTokenPlanModels[mimoTokenPlanDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "mimo-token-plan",
			baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
			apiKey: requireApiKey(options.mimoTokenPlanApiKey, "MiMo Token Plan"),
			modelId,
			modelInfo,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? mimoTokenPlanDefaultModelId
		const info =
			mimoTokenPlanModels[id as keyof typeof mimoTokenPlanModels] ||
			mimoTokenPlanModels[mimoTokenPlanDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: MIMO_TOKEN_PLAN_DEFAULT_TEMPERATURE,
		})
		return { id, info, ...params }
	}

	protected override processUsageMetrics(usage: {
		inputTokens?: number
		outputTokens?: number
		details?: {
			cachedInputTokens?: number
			reasoningTokens?: number
		}
		raw?: Record<string, unknown>
	}): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage.inputTokens || 0,
			outputTokens: usage.outputTokens || 0,
			cacheReadTokens: usage.details?.cachedInputTokens,
			reasoningTokens: usage.details?.reasoningTokens,
		}
	}

	protected override getMaxOutputTokens(): number | undefined {
		const modelInfo = this.config.modelInfo
		return this.options.modelMaxTokens || modelInfo.maxTokens || undefined
	}
}
