import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { wrapApiHandler, RetryWrapperOptions } from "../ApiRetryWrapper"
import { ApiErrorCategory } from "../ApiErrorClassifier"
import { DEFAULT_API_RETRY_OPTIONS } from "../ApiRetryStrategy"
import * as ApiRetryStrategy from "../ApiRetryStrategy"
import type { ApiHandler, ApiHandlerCreateMessageMetadata, SingleCompletionHandler } from "../../types"
import type { ApiStream } from "../../transform/stream"
import { taskEventBus } from "../../../core/events/TaskEventBus"

// Helper to build a mock handler whose createMessage yields chunks from an array
// and optionally throws on the first attempt.
function createMockHandler(config: {
	throwOnAttempt?: number // 0-based; undefined = never throw
	errorToThrow?: Error
	chunks?: Array<{ type: "text"; text: string }>
}): ApiHandler & SingleCompletionHandler {
	let attempt = 0
	return {
		getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
		countTokens: async () => 0,
		createMessage(_systemPrompt: string, _messages: unknown[], _metadata?: ApiHandlerCreateMessageMetadata): ApiStream {
			return (async function* () {
				const currentAttempt = attempt++
				if (config.throwOnAttempt !== undefined && currentAttempt === config.throwOnAttempt) {
					throw config.errorToThrow ?? new Error("mock stream error")
				}
				for (const chunk of config.chunks ?? [{ type: "text", text: "hello" }]) {
					yield chunk
				}
			})()
		},
		async completePrompt(_prompt: string): Promise<string> {
			const currentAttempt = attempt++
			if (config.throwOnAttempt !== undefined && currentAttempt === config.throwOnAttempt) {
				throw config.errorToThrow ?? new Error("mock completion error")
			}
			return "completed"
		},
	}
}

describe("wrapApiHandler", () => {
	beforeEach(() => {
		vi.spyOn(ApiRetryStrategy, "delayMs").mockImplementation(() => Promise.resolve())
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// ───────────────────────────────────────────────
	// 1. 429 with Retry-After
	// ───────────────────────────────────────────────
	it("retries on 429 and honours Retry-After header", async () => {
		const error429 = Object.assign(new Error("Too Many Requests"), {
			status: 429,
			headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
		})

		const mock = createMockHandler({ throwOnAttempt: 0, errorToThrow: error429, chunks: [{ type: "text", text: "ok" }] })
		const wrapped = wrapApiHandler(mock)

		const chunks: Array<{ type: string; text: string }> = []
		for await (const chunk of wrapped.createMessage("sys", [])) {
			chunks.push(chunk as { type: string; text: string })
		}

		expect(chunks).toEqual([{ type: "text", text: "ok" }])
	})

	// ───────────────────────────────────────────────
	// 2. 500/503 retries 3 times then throws
	// ───────────────────────────────────────────────
	it("retries on 500 up to maxAttempts then throws", async () => {
		const error500 = Object.assign(new Error("Internal Server Error"), { status: 500 })

		// Throw on every attempt (more than maxAttempts)
		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					calls++
					throw error500
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock)
		const iterator = wrapped.createMessage("sys", [])[Symbol.asyncIterator]()
		const promise = iterator.next()

		await expect(promise).rejects.toThrow("Internal Server Error")
		expect(calls).toBe(DEFAULT_API_RETRY_OPTIONS.maxAttempts)
	})

	it("retries on 503 up to maxAttempts then throws", async () => {
		const error503 = Object.assign(new Error("Service Unavailable"), { status: 503 })

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					calls++
					throw error503
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock)
		const iterator = wrapped.createMessage("sys", [])[Symbol.asyncIterator]()
		const promise = iterator.next()

		await expect(promise).rejects.toThrow("Service Unavailable")
		expect(calls).toBe(DEFAULT_API_RETRY_OPTIONS.maxAttempts)
	})

	it("retries on 503 up to maxAttempts then throws", async () => {
		const error503 = Object.assign(new Error("Service Unavailable"), { status: 503 })

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					calls++
					throw error503
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock)
		const iterator = wrapped.createMessage("sys", [])[Symbol.asyncIterator]()
		const promise = iterator.next()

		await expect(promise).rejects.toThrow("Service Unavailable")
		expect(calls).toBe(DEFAULT_API_RETRY_OPTIONS.maxAttempts)
	})

	// ───────────────────────────────────────────────
	// 3. 400/401/403 are NOT retried
	// ───────────────────────────────────────────────
	it.each([
		{ status: 400, label: "Bad Request" },
		{ status: 401, label: "Unauthorized" },
		{ status: 403, label: "Forbidden" },
	])("does not retry on $status ($label)", async ({ status }) => {
		const error = Object.assign(new Error(status.toString()), { status })

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					calls++
					throw error
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock)
		await expect(
			(async () => {
				for await (const _chunk of wrapped.createMessage("sys", [])) {
					// no-op
				}
			})(),
		).rejects.toThrow(status.toString())

		expect(calls).toBe(1)
	})

	// ───────────────────────────────────────────────
	// 4. completePrompt retry behaviour
	// ───────────────────────────────────────────────
	it("completePrompt retries on 429 and eventually succeeds", async () => {
		const error429 = Object.assign(new Error("Rate limited"), {
			status: 429,
			headers: { get: (name: string) => (name === "retry-after" ? "1" : null) },
		})

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage: () => (async function* () {})(),
			async completePrompt() {
				calls++
				if (calls < 2) throw error429
				return "success"
			},
		}

		const wrapped = wrapApiHandler(mock)
		const result = await wrapped.completePrompt!("hi")

		expect(result).toBe("success")
		expect(calls).toBe(2)
	})

	it("completePrompt does not retry on 401", async () => {
		const error401 = Object.assign(new Error("Unauthorized"), { status: 401 })

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage: () => (async function* () {})(),
			async completePrompt() {
				calls++
				throw error401
			},
		}

		const wrapped = wrapApiHandler(mock)
		await expect(wrapped.completePrompt!("hi")).rejects.toThrow("Unauthorized")
		expect(calls).toBe(1)
	})

	// ───────────────────────────────────────────────
	// 5. Configurable retry options
	// ───────────────────────────────────────────────
	it("respects custom maxAttempts", async () => {
		const error500 = Object.assign(new Error("Server Error"), { status: 500 })

		let calls = 0
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					calls++
					throw error500
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		const iterator = wrapped.createMessage("sys", [])[Symbol.asyncIterator]()
		const promise = iterator.next()

		await expect(promise).rejects.toThrow("Server Error")
		expect(calls).toBe(2)
	})

	// ───────────────────────────────────────────────
	// 6. Once the stream starts, mid-stream errors are not retried
	// ────────────────────────────────────────────
	it("does not retry mid-stream failures", async () => {
		let yielded = false
		const mock: ApiHandler & SingleCompletionHandler = {
			getModel: () => ({ id: "test", info: { maxTokens: 0, contextWindow: 0, supportsImages: false, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage(): ApiStream {
				return (async function* () {
					yield { type: "text", text: "first" }
					yielded = true
					throw new Error("mid-stream boom")
				})()
			},
			completePrompt: async () => "done",
		}

		const wrapped = wrapApiHandler(mock)
		const chunks: Array<unknown> = []
		await expect(
			(async () => {
				for await (const chunk of wrapped.createMessage("sys", [])) {
					chunks.push(chunk)
				}
			})(),
		).rejects.toThrow("mid-stream boom")

		expect(chunks).toEqual([{ type: "text", text: "first" }])
		expect(yielded).toBe(true)
	})

	// ───────────────────────────────────────────────
	// 7. Emits retry events via taskEventBus
	// ───────────────────────────────────────────────
	it("emits task:llm-retry events", async () => {
		const error429 = Object.assign(new Error("Rate limited"), {
			status: 429,
			headers: { get: (name: string) => (name === "retry-after" ? "1" : null) },
		})

		const mock = createMockHandler({ throwOnAttempt: 0, errorToThrow: error429, chunks: [{ type: "text", text: "ok" }] })
		const wrapped = wrapApiHandler(mock)

		const emitSpy = vi.spyOn(taskEventBus, "emit")

		for await (const _chunk of wrapped.createMessage("sys", [], { taskId: "task-123" })) {
			// no-op
		}

		expect(emitSpy).toHaveBeenCalledWith(
			"task:llm-retry",
			expect.objectContaining({
				taskId: "task-123",
				data: expect.objectContaining({
					attempt: 1,
					category: ApiErrorCategory.RateLimited,
				}),
			}),
		)
	})
})
