import { OpenAI } from "openai"
import { OpenAiNativeHandler } from "../../../api/providers/openai-native"
import { ApiHandlerOptions } from "../../../shared/api"
import { IEmbedder, EmbeddingResponse, EmbedderInfo } from "../interfaces"
import {
	MAX_BATCH_TOKENS,
	MAX_ITEM_TOKENS,
	MAX_BATCH_RETRIES as MAX_RETRIES,
	INITIAL_RETRY_DELAY_MS as INITIAL_DELAY_MS,
} from "../constants"
import { getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, formatEmbeddingError, HttpError } from "../shared/validation-helpers"
import { handleOpenAIError } from "../../../api/providers/utils/openai-error-handler"
import { logger } from "../../../shared/logger"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

/**
 * Estimates token count with character-set awareness.
 * English: ~4 chars/token (0.25 tokens/char). CJK: ~1-2 chars/token (0.6 tokens/char).
 * Falls back to length/4 for purely ASCII text.
 */
function estimateTokens(text: string): number {
	let asciiChars = 0
	let nonAsciiChars = 0
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) <= 127) {
			asciiChars++
		} else {
			nonAsciiChars++
		}
	}
	return Math.ceil(asciiChars / 4 + nonAsciiChars * 0.6)
}

/**
 * OpenAI implementation of the embedder interface with batching and rate limiting
 */
export class OpenAiEmbedder extends OpenAiNativeHandler implements IEmbedder {
	private embeddingsClient: OpenAI
	private readonly defaultModelId: string

	/**
	 * Creates a new OpenAI embedder
	 * @param options API handler options
	 */
	constructor(options: ApiHandlerOptions & { openAiEmbeddingModelId?: string }) {
		super(options)
		const apiKey = this.options.openAiNativeApiKey ?? "not-provided"

		// Wrap OpenAI client creation to handle invalid API key characters
		try {
			this.embeddingsClient = new OpenAI({ apiKey })
		} catch (error) {
			// Use the error handler to transform ByteString conversion errors
			throw handleOpenAIError(error, "OpenAI")
		}

		this.defaultModelId = options.openAiEmbeddingModelId || "text-embedding-3-small"
	}

	/**
	 * Creates embeddings for the given texts with batching and rate limiting
	 * @param texts Array of text strings to embed
	 * @param model Optional model identifier
	 * @returns Promise resolving to embedding response
	 */
	async createEmbeddings(texts: string[], model?: string): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId

		// Apply model-specific query prefix if required
		const queryPrefix = getModelQueryPrefix("openai", modelToUse)
		const processedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					const prefixedText = `${queryPrefix}${text}`
					const estimatedTokens = estimateTokens(prefixedText)
					if (estimatedTokens > MAX_ITEM_TOKENS) {
						logger.warn("OpenAIEmbedder",
								t("embeddings:textWithPrefixExceedsTokenLimit", {
									index,
									estimatedTokens,
									maxTokens: MAX_ITEM_TOKENS,
								}),
							)
						// Return original text if adding prefix would exceed limit
						return text
					}
					return prefixedText
				})
			: texts

		const allEmbeddings: number[][] = new Array(processedTexts.length)
		const usage = { promptTokens: 0, totalTokens: 0 }

		// Separate items that exceed the per-item token limit from embeddable ones.
		// Oversize items get zero-vector placeholders to maintain array alignment.
		const oversizeItems: Array<{ originalIndex: number }> = []
		const embeddableQueue: Array<{ originalIndex: number; text: string }> = []

		for (let i = 0; i < processedTexts.length; i++) {
			const itemTokens = estimateTokens(processedTexts[i]!)
			if (itemTokens > MAX_ITEM_TOKENS) {
				logger.warn("OpenAIEmbedder",
						t("embeddings:textExceedsTokenLimit", {
							index: i,
							itemTokens,
							maxTokens: MAX_ITEM_TOKENS,
						}),
					)
				oversizeItems.push({ originalIndex: i })
			} else {
				embeddableQueue.push({ originalIndex: i, text: processedTexts[i]! })
			}
		}

		while (embeddableQueue.length > 0) {
			const currentBatch: Array<{ originalIndex: number; text: string }> = []
			let currentBatchTokens = 0

			while (embeddableQueue.length > 0) {
				const item = embeddableQueue[0]!
				const itemTokens = estimateTokens(item.text)
				if (currentBatchTokens + itemTokens <= MAX_BATCH_TOKENS) {
					currentBatch.push(item)
					currentBatchTokens += itemTokens
					embeddableQueue.shift()
				} else {
					break
				}
			}

			if (currentBatch.length > 0) {
				const batchResult = await this._embedBatchWithRetries(
					currentBatch.map((item) => item.text),
					modelToUse,
				)
				for (let j = 0; j < currentBatch.length; j++) {
					allEmbeddings[currentBatch[j]!.originalIndex] = batchResult.embeddings[j]!
				}
				usage.promptTokens += batchResult.usage.promptTokens
				usage.totalTokens += batchResult.usage.totalTokens
			}
		}

		// Fill zero-vector placeholders for oversize items to maintain input/output alignment
		if (oversizeItems.length > 0) {
			const vectorSize = allEmbeddings.find((e) => e !== undefined && e.length > 0)?.length ?? 0
			const zeroVector = new Array(vectorSize).fill(0)
			for (const item of oversizeItems) {
				allEmbeddings[item.originalIndex] = zeroVector
			}
		}

		return { embeddings: allEmbeddings, usage }
	}

	/**
	 * Helper method to handle batch embedding with retries and exponential backoff
	 * @param batchTexts Array of texts to embed in this batch
	 * @param model Model identifier to use
	 * @returns Promise resolving to embeddings and usage statistics
	 */
	private async _embedBatchWithRetries(
		batchTexts: string[],
		model: string,
	): Promise<{ embeddings: number[][]; usage: { promptTokens: number; totalTokens: number } }> {
		for (let attempts = 0; attempts < MAX_RETRIES; attempts++) {
			try {
				const response = await this.embeddingsClient.embeddings.create({
					input: batchTexts,
					model: model,
				})

				return {
					embeddings: response.data.map((item) => item.embedding),
					usage: {
						promptTokens: response.usage?.prompt_tokens || 0,
						totalTokens: response.usage?.total_tokens || 0,
					},
				}
			} catch (error: unknown) {
				const hasMoreAttempts = attempts < MAX_RETRIES - 1

				// Check if it's a rate limit error
				const httpError = error as HttpError
				if (httpError?.status === 429 && hasMoreAttempts) {
					const delayMs = INITIAL_DELAY_MS * Math.pow(2, attempts)
					logger.warn("OpenAIEmbedder",
							t("embeddings:rateLimitRetry", {
								delayMs,
								attempt: attempts + 1,
								maxRetries: MAX_RETRIES,
							}),
						)
					await new Promise((resolve) => setTimeout(resolve, delayMs))
					continue
				}

				// Log the error for debugging
				logger.error("OpenAIEmbedder", `OpenAI embedder error (attempt ${attempts + 1}/${MAX_RETRIES}):`, error)
				try { TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR) } catch { /* best-effort */ }

				// Format and throw the error
				throw formatEmbeddingError(error, MAX_RETRIES)
			}
		}

		throw new Error(t("embeddings:failedMaxAttempts", { attempts: MAX_RETRIES }))
	}

	/**
	 * Validates the OpenAI embedder configuration by attempting a minimal embedding request
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(async () => {
			// Test with a minimal embedding request
			const response = await this.embeddingsClient.embeddings.create({
				input: ["test"],
				model: this.defaultModelId,
			})

			// Check if we got a valid response
			if (!response.data || response.data.length === 0) {
				return {
					valid: false,
					error: t("embeddings:openai.invalidResponseFormat"),
				}
			}

			return { valid: true }
		}, "openai")
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "openai",
		}
	}
}
