import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Mock } from "vitest"
import * as fsSync from "fs"

const { sharedMockGet, sharedMockSet, sharedMockDel } = vi.hoisted(() => ({
	sharedMockGet: vi.fn().mockReturnValue(undefined),
	sharedMockSet: vi.fn(),
	sharedMockDel: vi.fn(),
}))

vi.mock("@njust-ai-cj/telemetry", () => ({
	TelemetryService: { instance: { captureEvent: vi.fn() } },
}))

vi.mock("node-cache", () => ({
	default: vi.fn().mockImplementation(() => ({
		get: sharedMockGet,
		set: sharedMockSet,
		del: sharedMockDel,
	})),
}))

vi.mock("fs/promises", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue("{}"),
	mkdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
	readFileSync: vi.fn().mockReturnValue("{}"),
}))

vi.mock("../../../../core/config/ContextProxy", () => ({
	ContextProxy: {
		instance: {
			globalStorageUri: { fsPath: "/mock/storage/path" },
		},
	},
}))

vi.mock("../openai-compatible", () => ({
	fetchOpenAICompatibleModels: vi.fn(),
}))
vi.mock("../anthropic", () => ({
	fetchAnthropicModels: vi.fn(),
}))
vi.mock("../gemini", () => ({
	fetchGeminiModels: vi.fn(),
}))
vi.mock("../../../../shared/logger", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { listProviderModels } from "../modelCache"
import { fetchOpenAICompatibleModels } from "../openai-compatible"
import { fetchAnthropicModels } from "../anthropic"
import { fetchGeminiModels } from "../gemini"

const mockFetchOpenAI = fetchOpenAICompatibleModels as Mock<typeof fetchOpenAICompatibleModels>
const mockFetchAnthropic = fetchAnthropicModels as Mock<typeof fetchAnthropicModels>
const mockFetchGemini = fetchGeminiModels as Mock<typeof fetchGeminiModels>

const FAKE_MODELS_API = {
	"gpt-5.4": {
		maxTokens: undefined as undefined | number,
		contextWindow: 128000,
		supportsPromptCache: false,
		source: "api" as const,
	},
}

describe("listProviderModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sharedMockGet.mockReturnValue(undefined)
		vi.mocked(fsSync.existsSync).mockReturnValue(false)
		vi.mocked(fsSync.readFileSync).mockReturnValue("{}")
	})

	it("returns empty for fallback-only provider", async () => {
		const result = await listProviderModels("bedrock")
		expect(result).toEqual({})
	})

	it("returns empty for existing provider", async () => {
		const result = await listProviderModels("openrouter")
		expect(result).toEqual({})
	})

	it("returns memory cache hit without calling API", async () => {
		sharedMockGet.mockImplementation((key: string) => {
			if (key === "openai") return FAKE_MODELS_API
			return undefined
		})

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(result).toEqual(FAKE_MODELS_API)
		expect(mockFetchOpenAI).not.toHaveBeenCalled()
	})

	it("calls fetchOpenAICompatibleModels for openai-compatible providers", async () => {
		mockFetchOpenAI.mockResolvedValue(FAKE_MODELS_API)

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(mockFetchOpenAI).toHaveBeenCalledWith("openai", { apiKey: "k" })
		expect(result["gpt-5.4"].source).toBe("api")
	})

	it("calls fetchAnthropicModels for anthropic", async () => {
		const anthroModels = {
			"claude-sonnet-4-6": {
				maxTokens: undefined as undefined | number,
				contextWindow: 200000,
				supportsPromptCache: true,
				source: "api" as const,
			},
		}
		mockFetchAnthropic.mockResolvedValue(anthroModels)

		const result = await listProviderModels("anthropic", { apiKey: "k" })

		expect(mockFetchAnthropic).toHaveBeenCalledWith({ apiKey: "k" })
		expect(result["claude-sonnet-4-6"].source).toBe("api")
	})

	it("calls fetchGeminiModels for gemini", async () => {
		const geminiModels = {
			"gemini-2.5-flash": {
				maxTokens: undefined as undefined | number,
				contextWindow: 1000000,
				supportsPromptCache: false,
				source: "api" as const,
			},
		}
		mockFetchGemini.mockResolvedValue(geminiModels)

		const result = await listProviderModels("gemini", { apiKey: "k" })

		expect(mockFetchGemini).toHaveBeenCalledWith({ apiKey: "k" })
		expect(result["gemini-2.5-flash"].source).toBe("api")
	})

	it("returns fallback when API fails and no disk cache", async () => {
		mockFetchOpenAI.mockRejectedValue(new Error("network error"))

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(result["gpt-5.4"]).toBeDefined()
		expect(result["gpt-5.4"].source).toBe("hardcoded-fallback")
	})

	it("returns stale-disk-cache when API fails and old cache exists", async () => {
		const staleEntry = JSON.stringify({
			timestamp: Date.now() - 48 * 60 * 60 * 1000,
			models: FAKE_MODELS_API,
		})
		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockImplementation((p: any) => {
			if (String(p).includes("dynamic_openai")) return staleEntry
			return "{}"
		})

		mockFetchOpenAI.mockRejectedValue(new Error("timeout"))

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(result["gpt-5.4"]).toBeDefined()
		expect(result["gpt-5.4"].source).toBe("stale-disk-cache")
	})

	it("returns fallback when API returns empty and no disk cache", async () => {
		mockFetchOpenAI.mockResolvedValue({})

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(result["gpt-5.4"]).toBeDefined()
		expect(result["gpt-5.4"].source).toBe("hardcoded-fallback")
	})

	it("returns stale cache when API returns empty and disk cache exists", async () => {
		const diskEntry = JSON.stringify({
			timestamp: Date.now() - 48 * 60 * 60 * 1000,
			models: FAKE_MODELS_API,
		})
		vi.mocked(fsSync.existsSync).mockReturnValue(true)
		vi.mocked(fsSync.readFileSync).mockImplementation((p: any) => {
			if (String(p).includes("dynamic_openai")) return diskEntry
			return "{}"
		})

		mockFetchOpenAI.mockResolvedValue({})

		const result = await listProviderModels("openai", { apiKey: "k" })

		expect(result["gpt-5.4"].source).toBe("stale-disk-cache")
	})

	it("forceRefresh skips disk cache and calls API", async () => {
		mockFetchOpenAI.mockResolvedValue({
			"new-model": {
				maxTokens: undefined as undefined | number,
				contextWindow: 64000,
				supportsPromptCache: false,
				source: "api" as const,
			},
		})

		const result = await listProviderModels("openai", { apiKey: "k", forceRefresh: true })

		expect(mockFetchOpenAI).toHaveBeenCalled()
		expect(result["new-model"]).toBeDefined()
		expect(result["new-model"].source).toBe("api")
	})

	it("reuses in-flight request for concurrent calls", async () => {
		let resolveApi: (v: any) => void
		const pending = new Promise((resolve) => { resolveApi = resolve })
		mockFetchOpenAI.mockReturnValue(pending)

		const p1 = listProviderModels("openai", { apiKey: "k" })
		const p2 = listProviderModels("openai", { apiKey: "k" })

		expect(mockFetchOpenAI).toHaveBeenCalledTimes(1)

		resolveApi!(FAKE_MODELS_API)

		const [r1, r2] = await Promise.all([p1, p2])
		expect(r1["gpt-5.4"]).toBeDefined()
		expect(r2["gpt-5.4"]).toBeDefined()
	})
})
