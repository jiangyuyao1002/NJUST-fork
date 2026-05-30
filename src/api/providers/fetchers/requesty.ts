import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@njust-ai/types"

import { logger } from "../../../shared/logger"
import { parseApiPrice } from "../../../shared/cost"
import { toRequestyServiceUrl } from "../../../shared/utils/requesty"

const requestyModelSchema = z
	.object({
		id: z.string().min(1),
		max_output_tokens: z.number(),
		context_window: z.number(),
		supports_reasoning: z.boolean().optional(),
		supports_caching: z.boolean().optional(),
		supports_vision: z.boolean().optional(),
		input_price: z.union([z.string(), z.number()]).optional(),
		output_price: z.union([z.string(), z.number()]).optional(),
		description: z.string().optional(),
		caching_price: z.union([z.string(), z.number()]).optional(),
		cached_price: z.union([z.string(), z.number()]).optional(),
	})
	.passthrough()

const requestyModelsResponseSchema = z.object({
	data: z.array(z.unknown()),
})

type RequestyModel = z.infer<typeof requestyModelSchema>

export async function getRequestyModels(baseUrl?: string, apiKey?: string): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}

	try {
		const headers: Record<string, string> = {}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}

		const resolvedBaseUrl = toRequestyServiceUrl(baseUrl)
		const modelsUrl = new URL("v1/models", resolvedBaseUrl)

		const response = await axios.get(modelsUrl.toString(), { headers })
		const parsedResponse = requestyModelsResponseSchema.safeParse(response.data)
		const rawModels = parsedResponse.success ? parsedResponse.data.data : []

		if (!parsedResponse.success) {
			logger.error("Requesty", "Models response is invalid", parsedResponse.error.format())
		}

		for (const rawModelCandidate of rawModels) {
			const parsedModel = requestyModelSchema.safeParse(rawModelCandidate)
			if (!parsedModel.success) {
				logger.error("Requesty", "Skipping invalid model entry", parsedModel.error.format())
				continue
			}

			const rawModel: RequestyModel = parsedModel.data
			const supportsReasoning = rawModel.supports_reasoning ?? false
			const reasoningBudget =
				supportsReasoning &&
				(rawModel.id.includes("claude") ||
					rawModel.id.includes("coding/gemini-2.5") ||
					rawModel.id.includes("vertex/gemini-2.5"))
			const reasoningEffort =
				supportsReasoning && (rawModel.id.includes("openai") || rawModel.id.includes("google/gemini-2.5"))

			const modelInfo: ModelInfo = {
				maxTokens: rawModel.max_output_tokens,
				contextWindow: rawModel.context_window,
				supportsPromptCache: rawModel.supports_caching ?? false,
				supportsImages: rawModel.supports_vision,
				supportsReasoningBudget: reasoningBudget,
				supportsReasoningEffort: reasoningEffort,
				inputPrice: parseApiPrice(rawModel.input_price),
				outputPrice: parseApiPrice(rawModel.output_price),
				description: rawModel.description,
				cacheWritesPrice: parseApiPrice(rawModel.caching_price),
				cacheReadsPrice: parseApiPrice(rawModel.cached_price),
			}

			models[rawModel.id] = modelInfo
		}
	} catch (error) {
		logger.error(
			"Requesty",
			`Error fetching models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return models
}
