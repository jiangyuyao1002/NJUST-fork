import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchOpenAICompatibleModels } from "../openai-compatible"

describe("fetchOpenAICompatibleModels", () => {
	const originalFetch = globalThis.fetch
	const mockFetch = vi.fn()

	beforeEach(() => {
		globalThis.fetch = mockFetch
		mockFetch.mockReset()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("throws for unsupported provider", async () => {
		await expect(fetchOpenAICompatibleModels("bedrock" as any)).rejects.toThrow(
			"Unsupported OpenAI-compatible provider: bedrock",
		)
	})

	it("throws when API key is missing", async () => {
		const prev = process.env.OPENAI_API_KEY
		delete process.env.OPENAI_API_KEY
		await expect(fetchOpenAICompatibleModels("openai")).rejects.toThrow("Missing API key")
		process.env.OPENAI_API_KEY = prev
	})

	it("uses options.apiKey over env var", async () => {
		const models = {
			data: [
				{ id: "gpt-4o", context_window: 128000, max_tokens: 16384 },
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(models),
		})

		const result = await fetchOpenAICompatibleModels("openai", { apiKey: "test-key" })

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
			}),
		)
		expect(result["gpt-4o"]).toBeDefined()
		expect(result["gpt-4o"].source).toBe("api")
		expect(result["gpt-4o"].contextWindow).toBe(128000)
	})

	it("uses options.baseUrl over env and default", async () => {
		const models = { data: [{ id: "m1" }] }
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(models),
		})

		await fetchOpenAICompatibleModels("openai", {
			apiKey: "k",
			baseUrl: "https://custom.host/api",
		})

		expect(mockFetch).toHaveBeenCalledWith(
			"https://custom.host/api/models",
			expect.anything(),
		)
	})

	it("handles deepseek special baseUrl (no /v1)", async () => {
		const models = { data: [{ id: "deepseek-chat" }] }
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(models),
		})

		await fetchOpenAICompatibleModels("deepseek", { apiKey: "k" })

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.deepseek.com/models",
			expect.anything(),
		)
	})

	it("parses json.models when json.data is absent", async () => {
		const models = { models: [{ name: "my-model" }] }
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(models),
		})

		const result = await fetchOpenAICompatibleModels("openai", { apiKey: "k" })

		expect(result["my-model"]).toBeDefined()
	})

	it("throws on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			text: () => Promise.resolve("rate limited"),
		})

		await expect(
			fetchOpenAICompatibleModels("openai", { apiKey: "k" }),
		).rejects.toThrow("Failed to fetch models for openai: 429")
	})

	it("returns empty record when response has no data or models array", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		})

		const result = await fetchOpenAICompatibleModels("openai", { apiKey: "k" })
		expect(Object.keys(result)).toHaveLength(0)
	})

	it("skips items without id or name", async () => {
		const models = {
			data: [{ id: "valid" }, { foo: "bar" }, { id: 123 }],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(models),
		})

		const result = await fetchOpenAICompatibleModels("openai", { apiKey: "k" })
		expect(Object.keys(result)).toEqual(["valid"])
	})

	it("applies defaults when API fields are missing", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ data: [{ id: "m" }] }),
		})

		const result = await fetchOpenAICompatibleModels("openai", { apiKey: "k" })
		expect(result["m"].contextWindow).toBe(128_000)
		expect(result["m"].supportsPromptCache).toBe(false)
		expect(result["m"].maxTokens).toBeUndefined()
	})
})
