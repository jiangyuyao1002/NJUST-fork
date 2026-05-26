import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchGeminiModels } from "../gemini"

describe("fetchGeminiModels", () => {
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
		const prev = process.env.GEMINI_API_KEY
		delete process.env.GEMINI_API_KEY
		await expect(fetchGeminiModels()).rejects.toThrow("Missing Gemini API key")
		process.env.GEMINI_API_KEY = prev
	})

	it("passes API key as query parameter", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ models: [] }),
		})

		await fetchGeminiModels({ apiKey: "my-key" })

		const calledUrl = mockFetch.mock.calls[0][0] as string
		expect(calledUrl).toContain("key=my-key")
		expect(calledUrl).toContain("/v1beta/models")
	})

	it("strips 'models/' prefix from model names", async () => {
		const response = {
			models: [
				{
					name: "models/gemini-2.5-flash",
					displayName: "Gemini 2.5 Flash",
					inputTokenLimit: 1048576,
					outputTokenLimit: 65536,
					supportedGenerationMethods: ["generateContent"],
				},
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(response),
		})

		const result = await fetchGeminiModels({ apiKey: "k" })

		expect(result["gemini-2.5-flash"]).toBeDefined()
		expect(result["gemini-2.5-flash"].contextWindow).toBe(1_048_576)
		expect(result["gemini-2.5-flash"].maxTokens).toBe(65_536)
		expect(result["gemini-2.5-flash"].source).toBe("api")
	})

	it("filters out models without generateContent method", async () => {
		const response = {
			models: [
				{
					name: "models/text-embedding-004",
					supportedGenerationMethods: ["embedContent"],
				},
				{
					name: "models/gemini-2.5-flash",
					supportedGenerationMethods: ["generateContent"],
				},
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(response),
		})

		const result = await fetchGeminiModels({ apiKey: "k" })

		expect(Object.keys(result)).toEqual(["gemini-2.5-flash"])
	})

	it("filters out models without supportedGenerationMethods", async () => {
		const response = {
			models: [
				{ name: "models/no-methods" },
				{
					name: "models/gemini-2.5-flash",
					supportedGenerationMethods: ["generateContent"],
				},
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(response),
		})

		const result = await fetchGeminiModels({ apiKey: "k" })

		expect(Object.keys(result)).toEqual(["gemini-2.5-flash"])
	})

	it("skips items without name", async () => {
		const response = {
			models: [
				{ supportedGenerationMethods: ["generateContent"] },
			],
		}
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(response),
		})

		const result = await fetchGeminiModels({ apiKey: "k" })
		expect(Object.keys(result)).toHaveLength(0)
	})

	it("applies defaults when fields are missing", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({
				models: [
					{
						name: "models/minimal",
						supportedGenerationMethods: ["generateContent"],
					},
				],
			}),
		})

		const result = await fetchGeminiModels({ apiKey: "k" })
		expect(result["minimal"].contextWindow).toBe(1_000_000)
		expect(result["minimal"].maxTokens).toBeUndefined()
	})

	it("uses options.baseUrl", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ models: [] }),
		})

		await fetchGeminiModels({ apiKey: "k", baseUrl: "https://custom.googleapis.com/v1beta" })

		const calledUrl = mockFetch.mock.calls[0][0] as string
		expect(calledUrl).toContain("https://custom.googleapis.com/v1beta/models")
	})

	it("throws on HTTP error", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 400,
			text: () => Promise.resolve("bad request"),
		})

		await expect(
			fetchGeminiModels({ apiKey: "k" }),
		).rejects.toThrow("Failed to fetch Gemini models: 400")
	})
})
