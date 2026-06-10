import axios from "axios"
import { z } from "zod"

import type { ModelInfo } from "@njust-ai/types"
import {
	VERCEL_AI_GATEWAY_VISION_ONLY_MODELS,
	VERCEL_AI_GATEWAY_VISION_AND_TOOLS_MODELS,
} from "@njust-ai/core/providers"

import type { ApiHandlerOptions } from "../../../shared/api"
import { logger } from "../../../shared/logger"
import { parseApiPrice } from "../../../shared/cost"

/**
 * VercelAiGatewayPricing
 */

const vercelAiGatewayPricingSchema = z.object({
	input: z.string().optional(), // Image models don't have an input price.
	output: z.string().optional(), // Embedding and image models don't have an output price.
	input_cache_write: z.string().optional(),
	input_cache_read: z.string().optional(),
	image: z.string().optional(), // Only image models have an image price.
})

/**
 * VercelAiGatewayModel
 */

const vercelAiGatewayModelSchema = z.object({
	id: z.string(),
	object: z.string(),
	created: z.number(),
	owned_by: z.string(),
	name: z.string(),
	description: z.string(),
	context_window: z.number(),
	max_tokens: z.number(),
	type: z.string(),
	pricing: vercelAiGatewayPricingSchema,
})

export type VercelAiGatewayModel = z.infer<typeof vercelAiGatewayModelSchema>

/**
 * VercelAiGatewayModelsResponse
 */

const vercelAiGatewayModelsResponseSchema = z.object({
	object: z.string().optional(),
	data: z.array(z.unknown()),
})

type VercelAiGatewayModelsResponse = z.infer<typeof vercelAiGatewayModelsResponseSchema>

/**
 * getVercelAiGatewayModels
 */

export async function getVercelAiGatewayModels(_options?: ApiHandlerOptions): Promise<Record<string, ModelInfo>> {
	const models: Record<string, ModelInfo> = {}
	const baseURL = "https://ai-gateway.vercel.sh/v1"

	try {
		const response = await axios.get<VercelAiGatewayModelsResponse>(`${baseURL}/models`)
		const result = vercelAiGatewayModelsResponseSchema.safeParse(response.data)

		if (!result.success) {
			logger.error("VercelAiGateway", `Models response is invalid ${JSON.stringify(result.error.format())}`)
		} else if (result.data.object === undefined) {
			logger.error("VercelAiGateway", "Models response is missing object field")
		}

		for (const rawModel of result.success ? result.data.data : []) {
			const parsedModel = vercelAiGatewayModelSchema.safeParse(rawModel)
			if (!parsedModel.success) {
				logger.error(
					"VercelAiGateway",
					`Skipping invalid model entry ${JSON.stringify(parsedModel.error.format())}`,
				)
				continue
			}
			const model = parsedModel.data
			const { id } = model

			// Only include language models for chat inference.
			// Embedding models are statically defined in embeddingModels.ts.
			if (model.type !== "language") {
				continue
			}

			models[id] = parseVercelAiGatewayModel({ id, model })
		}
	} catch (error) {
		logger.error(
			"VercelAiGateway",
			`Error fetching models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
	}

	return models
}

/**
 * parseVercelAiGatewayModel
 */

export const parseVercelAiGatewayModel = ({ id, model }: { id: string; model: VercelAiGatewayModel }): ModelInfo => {
	const cacheWritesPrice = model.pricing?.input_cache_write
		? parseApiPrice(model.pricing?.input_cache_write)
		: undefined

	const cacheReadsPrice = model.pricing?.input_cache_read ? parseApiPrice(model.pricing?.input_cache_read) : undefined

	const supportsPromptCache = typeof cacheWritesPrice !== "undefined" && typeof cacheReadsPrice !== "undefined"
	const supportsImages =
		VERCEL_AI_GATEWAY_VISION_ONLY_MODELS.has(id) || VERCEL_AI_GATEWAY_VISION_AND_TOOLS_MODELS.has(id)

	const modelInfo: ModelInfo = {
		maxTokens: model.max_tokens,
		contextWindow: model.context_window,
		supportsImages,
		supportsPromptCache,
		inputPrice: parseApiPrice(model.pricing?.input),
		outputPrice: parseApiPrice(model.pricing?.output),
		cacheWritesPrice,
		cacheReadsPrice,
		description: model.description,
	}

	return modelInfo
}
