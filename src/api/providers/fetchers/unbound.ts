import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@njust-ai/types"

import { logger } from "../../../shared/logger"
import { parseApiPrice } from "../../../shared/cost"

const unboundModelSchema = z
	.object({
		id: z.string().min(1),
		max_output_tokens: z.number().optional(),
		context_window: z.number().optional(),
		supports_caching: z.boolean().optional(),
		supports_vision: z.boolean().optional(),
		input_price: z.union([z.string(), z.number()]).optional(),
		output_price: z.union([z.string(), z.number()]).optional(),
		description: z.string().optional(),
		caching_price: z.union([z.string(), z.number()]).optional(),
		cached_price: z.union([z.string(), z.number()]).optional(),
	})
	.passthrough()

const unboundModelsResponseSchema = z.union([
	z.object({ data: z.array(z.unknown()) }).passthrough(),
	z.array(z.unknown()),
])

type UnboundModel = z.infer<typeof unboundModelSchema>

export async function getUnboundModels(apiKey?: string | null): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const response = await axios.get("https://api.getunbound.ai/models", { headers })
		const parsedResponse = unboundModelsResponseSchema.safeParse(response.data)
		const rawModels = parsedResponse.success
			? Array.isArray(parsedResponse.data)
				? parsedResponse.data
				: parsedResponse.data.data
			: []

		if (!parsedResponse.success) {
			logger.error("Unbound", "Models response is invalid", parsedResponse.error.format())
		}

		for (const rawModelCandidate of rawModels) {
			const parsedModel = unboundModelSchema.safeParse(rawModelCandidate)
			if (!parsedModel.success) {
				logger.error("Unbound", "Skipping invalid model entry", parsedModel.error.format())
				continue
			}

			const rawModel: UnboundModel = parsedModel.data
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
