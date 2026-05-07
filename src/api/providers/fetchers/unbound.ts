import axios from "axios"

import type { ModelInfo } from "@njust-ai-cj/types"

import { logger } from "../../../shared/logger"
import { parseApiPrice } from "../../../shared/cost"

export async function getUnboundModels(apiKey?: string | null): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get("https://api.getunbound.ai/models", { headers })
		const raw = response.data?.data ?? response.data
		const rawModels = Array.isArray(raw) ? raw : []

		for (const rawModel of rawModels) {
			const modelInfo: ModelInfo = {
				maxTokens: rawModel.max_output_tokens ?? 8192,
				contextWindow: rawModel.context_window ?? 200_000,
				supportsPromptCache: rawModel.supports_caching ?? false,
				supportsImages: rawModel.supports_vision ?? false,
				inputPrice: parseApiPrice(rawModel.input_price),
				outputPrice: parseApiPrice(rawModel.output_price),
				description: rawModel.description,
				cacheWritesPrice: parseApiPrice(rawModel.caching_price),
				cacheReadsPrice: parseApiPrice(rawModel.cached_price),
			}

			models[rawModel.id] = modelInfo
		}
	} catch (error) {
		logger.error("Unbound", `Error fetching models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}

	return models
}
