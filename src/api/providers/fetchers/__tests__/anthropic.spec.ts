import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchAnthropicModels } from "../anthropic"

describe("fetchAnthropicModels", () => {
	const originalFetch = globalThis.fetch
	const mockFetch = vi.fn()

	beforeEach(() => {
		globalThis.fetch = mockFetch
		mockFetch.mockReset()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	it("throws when API key is missing", async () => {
		const prev = process.env.ANTHROPIC_API_KEY
		delete process.env.ANTHROPIC_API_KEY
		await expect(fetchAnthropicModels()).rejects.toThrow("Missing Anthropic API key")
		process.env.ANTHROPIC_API_KEY = prev
	})

	it("sends correct headers", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ data: [] }),
		})

		await fetchAnthropicModels({ apiKey: "sk-test" })

		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.anthropic.com/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({
					"x-api-key": "sk-test",
					"anthropic-version": "2023-06-01",
				}),
			}),
		)
	})

	it("uses options.baseUrl", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ data: [] }),
		})

		await fetchAnthropicModels({ apiKey: "k", baseUrl: "https://proxy.example.com" })

		expect(mockFetch).toHaveBeenCalledWith(
			"https://proxy.example.com/models",
			expect.anything(),
		)
	})

	it("parses Anthropic model data with capabilities", async () => {
		const response = {
			data: [
				{
					id: "claude-sonnet-4-20250514",
					display_name: "Claude Sonnet 4",
					max_input_tokens: 200000,
					max_tokens: 16384,
					capabilities: {
						image_input: { supported: true },
						prompt_cache: { supported: true },
						thinking: { supported: true },
					},
				},
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(response),
		})

		const result = await fetchAnthropicModels({ apiKey: "k" })

		expect(result["claude-sonnet-4-20250514"]).toEqual({
			maxTokens: 16384,
			contextWindow: 200000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningBudget: true,
			deprecated: false,
			source: "api",
		})
	})

	it("applies defaults when fields are missing", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ data: [{ id: "simple-model" }] }),
		})

		const result = await fetchAnthropicModels({ apiKey: "k" })

		expect(result["simple-model"].contextWindow).toBe(200_000)
		expect(result["simple-model"].supportsImages).toBeUndefined()
		expect(result["simple-model"].supportsPromptCache).toBe(false)
	})

	it("skips items without id", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ data: [{ display_name: "no-id" }] }),
		})

		const result = await fetchAnthropicModels({ apiKey: "k" })
		expect(Object.keys(result)).toHaveLength(0)
	})

	it("throws on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve("unauthorized"),
		})

		await expect(
			fetchAnthropicModels({ apiKey: "bad" }),
		).rejects.toThrow("Failed to fetch Anthropic models: 401")
	})
})
