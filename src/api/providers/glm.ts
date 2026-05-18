import { glmModels, glmDefaultModelId } from "@njust-ai-cj/core/providers"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible"
import { requireApiKey } from "../interfaces/api-key-validator"

export class GlmHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? glmDefaultModelId
		const modelInfo = glmModels[modelId as keyof typeof glmModels] || glmModels[glmDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "glm",
			baseURL: options.glmBaseUrl || "https://open.bigmodel.cn/api/paas/v4",
			apiKey: requireApiKey(options.glmApiKey, "GLM"),
			modelId,
			modelInfo,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? glmDefaultModelId
		const info = glmModels[id as keyof typeof glmModels] || glmModels[glmDefaultModelId]
		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
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
