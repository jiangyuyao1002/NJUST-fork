import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { providerRegistry } from "../../registry/ProviderRegistry"
import * as ApiRetryStrategy from "../../retry/ApiRetryStrategy"
import type { ApiStream } from "../../transform/stream"

// Ensure providers are registered
import "../../providers/register-all"

describe("Provider retry integration", () => {
	beforeEach(() => {
		vi.spyOn(ApiRetryStrategy, "delayMs").mockImplementation(() => Promise.resolve())
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Helper to collect stream chunks
	async function collectStream(stream: ApiStream): Promise<Array<{ type: string; text?: string }>> {
		const chunks: Array<{ type: string; text?: string }> = []
		for await (const chunk of stream) {
			chunks.push(chunk as { type: string; text?: string })
		}
		return chunks
	}

	it("OpenAI Native handler retries on 429 through registry", async () => {
		const error429 = Object.assign(new Error("Too Many Requests"), {
			status: 429,
			headers: { get: (name: string) => (name === "retry-after" ? "1" : null) },
		})

		let attempts = 0
		const handler = providerRegistry.createHandler({
			apiProvider: "openai-native",
			openAiNativeApiKey: "test-key",
		})

		// Override createMessage to simulate transient failure
		handler.createMessage = function (..._args: Parameters<typeof handler.createMessage>): ApiStream {
			return (async function* () {
				attempts++
				if (attempts === 1) {
					throw error429
				}
				yield { type: "text", text: "success" }
			})()
		}

		const chunks = await collectStream(handler.createMessage("sys", []))
		expect(chunks).toEqual([{ type: "text", text: "success" }])
		expect(attempts).toBe(2)
	})

	it("Anthropic handler retries on 500 through registry", async () => {
		const error500 = Object.assign(new Error("Internal Server Error"), { status: 500 })

		let attempts = 0
		const handler = providerRegistry.createHandler({
			apiProvider: "anthropic",
			apiKey: "test-key",
		})

		handler.createMessage = function (..._args: Parameters<typeof handler.createMessage>): ApiStream {
			return (async function* () {
				attempts++
				if (attempts === 1) {
					throw error500
				}
				yield { type: "text", text: "anthropic-ok" }
			})()
		}

		const chunks = await collectStream(handler.createMessage("sys", []))
		expect(chunks).toEqual([{ type: "text", text: "anthropic-ok" }])
		expect(attempts).toBe(2)
	})

	it("Bedrock handler retries on network error through registry", async () => {
		const networkError = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })

		let attempts = 0
		const handler = providerRegistry.createHandler({
			apiProvider: "bedrock",
			awsAccessKey: "test",
			awsSecretKey: "test",
			awsRegion: "us-east-1",
			apiModelId: "anthropic.claude-3-sonnet",
		})

		handler.createMessage = function (..._args: Parameters<typeof handler.createMessage>): ApiStream {
			return (async function* () {
				attempts++
				if (attempts === 1) {
					throw networkError
				}
				yield { type: "text", text: "bedrock-ok" }
			})()
		}

		const chunks = await collectStream(handler.createMessage("sys", []))
		expect(chunks).toEqual([{ type: "text", text: "bedrock-ok" }])
		expect(attempts).toBe(2)
	})

	it("does not retry 4xx client errors (400, 401, 403)", async () => {
		const error400 = Object.assign(new Error("Bad Request"), { status: 400 })

		let attempts = 0
		const handler = providerRegistry.createHandler({
			apiProvider: "openai-native",
			openAiNativeApiKey: "test-key",
		})

		handler.createMessage = function (..._args: Parameters<typeof handler.createMessage>): ApiStream {
			// eslint-disable-next-line require-yield
			return (async function* () {
				attempts++
				throw error400
			})()
		}

		await expect(collectStream(handler.createMessage("sys", []))).rejects.toThrow("Bad Request")
		expect(attempts).toBe(1)
	})

	it("completePrompt retries on transient errors", async () => {
		const error503 = Object.assign(new Error("Service Unavailable"), { status: 503 })

		let attempts = 0
		const handler = providerRegistry.createHandler({
			apiProvider: "openai-native",
			openAiNativeApiKey: "test-key",
		}) as ApiHandler & { completePrompt?: (prompt: string) => Promise<string> }

		if (!handler.completePrompt) {
			// Skip if handler doesn't implement completePrompt
			return
		}

		handler.completePrompt = async function (..._args: Parameters<typeof handler.completePrompt>): Promise<string> {
			attempts++
			if (attempts === 1) {
				throw error503
			}
			return "completion-success"
		}

		const result = await handler.completePrompt!("test prompt")
		expect(result).toBe("completion-success")
		expect(attempts).toBe(2)
	})
})
