import axios from "axios"
import { z } from "zod"

import type { ModelRecord } from "@njust-ai/types"

import { logger } from "../../../shared/logger"
import { DEFAULT_HEADERS } from "../constants"
import { getErrorMessage } from "../../../shared/error-utils"

const liteLlmModelInfoSchema = z
	.object({
		max_output_tokens: z.number().optional(),
		max_tokens: z.number().optional(),
		max_input_tokens: z.number().optional(),
		supports_vision: z.boolean().optional(),
		supports_prompt_caching: z.boolean().optional(),
		input_cost_per_token: z.number().optional(),
		output_cost_per_token: z.number().optional(),
		cache_creation_input_token_cost: z.number().optional(),
		cache_read_input_token_cost: z.number().optional(),
	})
	.passthrough()

const liteLlmModelEntrySchema = z
	.object({
		model_name: z.string().min(1),
		model_info: liteLlmModelInfoSchema,
		litellm_params: z
			.object({
				model: z.string().min(1),
			})
			.passthrough(),
	})
	.passthrough()

const liteLlmModelsResponseSchema = z.object({
	data: z.array(z.unknown()),
})

type LiteLlmModelEntry = z.infer<typeof liteLlmModelEntrySchema>
/**
 * Fetches available models from a LiteLLM server
 *
 * @param apiKey The API key for the LiteLLM server
 * @param baseUrl The base URL of the LiteLLM server
 * @returns A promise that resolves to a record of model IDs to model info
 * @throws Will throw an error if the request fails or the response is not as expected.
 */
export async function getLiteLLMModels(apiKey: string, baseUrl: string): Promise<ModelRecord> {
	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...DEFAULT_HEADERS,
		}

		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`
		}
		// Use URL constructor to properly join base URL and path
		// This approach handles all edge cases including paths, query params, and fragments
		const urlObj = new URL(baseUrl)
		// Normalize the pathname by removing trailing slashes and multiple slashes
		urlObj.pathname = urlObj.pathname.replace(/\/+$/, "").replace(/\/+/g, "/") + "/v1/model/info"
		const url = urlObj.href
		// Added timeout to prevent indefinite hanging
		const response = await axios.get(url, { headers, timeout: 5000 })
		const parsedResponse = liteLlmModelsResponseSchema.safeParse(response.data)
		const models: ModelRecord = {}

		if (parsedResponse.success) {
			for (const rawModel of parsedResponse.data.data) {
				const parsedModel = liteLlmModelEntrySchema.safeParse(rawModel)
				if (!parsedModel.success) {
					logger.error("LiteLLM", "Skipping invalid LiteLLM model entry", parsedModel.error.format())
					continue
				}

				const model: LiteLlmModelEntry = parsedModel.data
				const modelName = model.model_name
				const modelInfo = model.model_info
				const litellmModelName = model.litellm_params.model

				if (!litellmModelName) continue

				models[modelName] = {
					maxTokens: modelInfo.max_output_tokens || modelInfo.max_tokens || 8192,
					contextWindow: modelInfo.max_input_tokens || 200000,
					supportsImages: Boolean(modelInfo.supports_vision),
					supportsPromptCache: Boolean(modelInfo.supports_prompt_caching),
					inputPrice: modelInfo.input_cost_per_token ? modelInfo.input_cost_per_token * 1000000 : undefined,
					outputPrice: modelInfo.output_cost_per_token
						? modelInfo.output_cost_per_token * 1000000
						: undefined,
					cacheWritesPrice: modelInfo.cache_creation_input_token_cost
						? modelInfo.cache_creation_input_token_cost * 1000000
						: undefined,
					cacheReadsPrice: modelInfo.cache_read_input_token_cost
						? modelInfo.cache_read_input_token_cost * 1000000
						: undefined,
					description: `${modelName} via LiteLLM proxy`,
				}
			}
		} else {
			// If response.data.data is not in the expected format, consider it an error.
			logger.error("LiteLLM", "Error fetching LiteLLM models: Unexpected response format", response.data)
			throw new Error("Failed to fetch LiteLLM models: Unexpected response format.")
		}

		return models
	} catch (error: unknown) {
		const errorMessage = getErrorMessage(error)
		logger.error("LiteLLM", "Error fetching LiteLLM models:", errorMessage)
		if (axios.isAxiosError(error) && error.response) {
			throw new Error(
				`Failed to fetch LiteLLM models: ${error.response.status} ${error.response.statusText}. Check base URL and API key.`,
			)
		} else if (axios.isAxiosError(error) && error.request) {
			throw new Error(
				"Failed to fetch LiteLLM models: No response from server. Check LiteLLM server status and base URL.",
			)
		} else {
			throw new Error(`Failed to fetch LiteLLM models: ${errorMessage || "An unknown error occurred."}`)
		}
	}
}
