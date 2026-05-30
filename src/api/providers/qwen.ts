import { qwenModels, qwenDefaultModelId } from "@njust-ai/core/providers"

import type { ApiHandlerOptions } from "../../shared/api"

import type { ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { OpenAICompatibleHandler, OpenAICompatibleConfig } from "./openai-compatible"
import { requireApiKey } from "../interfaces/api-key-validator"

export class QwenHandler extends OpenAICompatibleHandler {
	constructor(options: ApiHandlerOptions) {
		const modelId = options.apiModelId ?? qwenDefaultModelId
		const modelInfo = qwenModels[modelId as keyof typeof qwenModels] || qwenModels[qwenDefaultModelId]

		const config: OpenAICompatibleConfig = {
			providerName: "qwen",
			baseURL: options.qwenBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1",
			apiKey: requireApiKey(options.qwenApiKey, "Qwen"),
			modelId,
			modelInfo,
			modelMaxTokens: options.modelMaxTokens ?? undefined,
			temperature: options.modelTemperature ?? undefined,
		}

		super(options, config)
	}

	override getModel() {
		const id = this.options.apiModelId ?? qwenDefaultModelId
		const info = qwenModels[id as keyof typeof qwenModels] || qwenModels[qwenDefaultModelId]
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
