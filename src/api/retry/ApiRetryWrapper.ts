import { Anthropic } from "@anthropic-ai/sdk"

import type { ApiHandler, ApiHandlerCreateMessageMetadata, SingleCompletionHandler } from "../types"
import type { ApiStream, ApiStreamChunk } from "../transform/stream"
import {
	analyzeErrorForRetry,
	ApiErrorCategory,
} from "./ApiErrorClassifier"
import {
	computeBackoffMs,
	delayMs,
	DEFAULT_API_RETRY_OPTIONS,
	type ApiRetryOptions,
} from "./ApiRetryStrategy"
import { taskEventBus } from "../../core/events/TaskEventBus"

export type RetryWrapperOptions = Partial<ApiRetryOptions>

/**
 * Wraps an AsyncGenerator so that failures on the *first* `next()` call
 * (the stream open / transport phase) are retried with exponential backoff.
 * Once the first chunk has been yielded, mid-stream errors are passed through
 * without retry.
 */
async function* wrapStreamWithRetry(
	createStream: () => ApiStream,
	context: { provider?: string; taskId?: string },
	retryConfig?: RetryWrapperOptions,
): ApiStream {
	const config = { ...DEFAULT_API_RETRY_OPTIONS, ...retryConfig }
	let lastError: unknown

	for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
		let iterator: AsyncIterator<ApiStreamChunk> | undefined

		// Retry loop only covers the *first* next() call (stream open phase).
		try {
			const stream = createStream()
			iterator = stream[Symbol.asyncIterator]()
			const first = await iterator.next()

			if (first.done) {
				return
			}

			yield first.value
		} catch (error) {
			lastError = error
			const decision = analyzeErrorForRetry(error)

			if (!decision.shouldRetry || attempt >= config.maxAttempts - 1) {
				throw error
			}

			const delay = computeBackoffMs(attempt, config, decision.retryAfterSeconds)
			taskEventBus.emit("task:llm-retry", {
				taskId: context.taskId,
				data: {
					attempt: attempt + 1,
					delayMs: delay,
					category: decision.category,
					provider: context.provider ?? "unknown",
				},
			})
			await delayMs(delay)
			continue
		}

		// First chunk succeeded — proxy the rest of the stream WITHOUT retry.
		yield* { [Symbol.asyncIterator]: () => iterator! }
		return
	}

	throw lastError
}

/**
 * Wraps an `ApiHandler` so that **both** `createMessage` and `completePrompt`
 * automatically retry on 429 / 5xx / network errors.
 *
 * - `createMessage` retries only the *stream open* phase (first chunk).  Once
 *   the stream is flowing, mid-stream failures pass through untouched.
 * - `completePrompt` retries the entire call.
 * - 4xx client errors (400, 401, 403 …) are **not** retried.
 * - 429 responses honour the `Retry-After` header when present.
 */
export function wrapApiHandler(
	handler: ApiHandler & Partial<SingleCompletionHandler>,
	retryConfig?: RetryWrapperOptions,
): ApiHandler & Partial<SingleCompletionHandler> {
	const providerName = handler.constructor.name

	return new Proxy(handler, {
		get(target, prop) {
			if (prop === "createMessage") {
				return (
					systemPrompt: string,
					messages: Anthropic.Messages.MessageParam[],
					metadata?: ApiHandlerCreateMessageMetadata,
				): ApiStream => {
					return wrapStreamWithRetry(
						() => target.createMessage(systemPrompt, messages, metadata),
						{ provider: providerName, taskId: metadata?.taskId },
						retryConfig,
					)
				}
			}

			if (prop === "completePrompt") {
				return async (prompt: string): Promise<string> => {
					if (!target.completePrompt) {
						throw new Error(`${providerName} does not implement completePrompt`)
					}

					const config = { ...DEFAULT_API_RETRY_OPTIONS, ...retryConfig }
					let lastError: unknown

					for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
						try {
							return await target.completePrompt!(prompt)
						} catch (error) {
							lastError = error
							const decision = analyzeErrorForRetry(error)

							if (!decision.shouldRetry || attempt >= config.maxAttempts - 1) {
								throw error
							}

							const delay = computeBackoffMs(attempt, config, decision.retryAfterSeconds)
							taskEventBus.emit("task:llm-retry", {
								data: {
									attempt: attempt + 1,
									delayMs: delay,
									category: decision.category,
									provider: providerName,
								},
							})
							await delayMs(delay)
						}
					}

					throw lastError
				}
			}

			return Reflect.get(target, prop)
		},
	}) as ApiHandler & Partial<SingleCompletionHandler>
}

export { ApiErrorCategory }
