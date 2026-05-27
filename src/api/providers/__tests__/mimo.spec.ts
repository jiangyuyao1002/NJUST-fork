// npx vitest run src/api/providers/__tests__/mimo.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ApiHandlerOptions } from "../../../shared/api"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	RelativePattern: vi.fn(),
}))

vi.mock("@ai-sdk/openai-compatible", () => ({
	createOpenAICompatible: vi.fn(() => vi.fn()),
}))

vi.mock("openai", () => ({
	default: vi.fn(),
}))

vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn(),
}))

import { MimoHandler } from "../mimo"
import { MimoTokenPlanHandler } from "../mimo-token-plan"
import { mimoModels, mimoDefaultModelId } from "@njust-ai-cj/core/providers"
import { mimoTokenPlanModels, mimoTokenPlanDefaultModelId } from "@njust-ai-cj/core/providers"

function makeMimoOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		mimoApiKey: "test-mimo-key",
		...overrides,
	} as ApiHandlerOptions
}

function makeTokenPlanOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		mimoTokenPlanApiKey: "tp-test-key",
		...overrides,
	} as ApiHandlerOptions
}

describe("MimoHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("getModel returns default model when no apiModelId", () => {
		const handler = new MimoHandler(makeMimoOptions())
		const result = handler.getModel()
		expect(result.id).toBe(mimoDefaultModelId)
		expect(result.info).toEqual(mimoModels[mimoDefaultModelId])
	})

	it("getModel returns specified model when valid model id provided", () => {
		const handler = new MimoHandler(makeMimoOptions({ apiModelId: "mimo-v2-flash" }))
		const result = handler.getModel()
		expect(result.id).toBe("mimo-v2-flash")
		expect(result.info).toEqual(mimoModels["mimo-v2-flash"])
	})

	it("getModel falls back to default for unknown model id", () => {
		const handler = new MimoHandler(makeMimoOptions({ apiModelId: "nonexistent-model" }))
		const result = handler.getModel()
		expect(result.info).toBeDefined()
	})

	it("processUsageMetrics maps fields correctly", () => {
		const handler = new MimoHandler(makeMimoOptions())
		const metrics = (handler as any).processUsageMetrics({
			inputTokens: 100,
			outputTokens: 50,
			details: { cachedInputTokens: 10, reasoningTokens: 5 },
		})
		expect(metrics).toEqual({
			type: "usage",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 10,
			reasoningTokens: 5,
		})
	})

	it("processUsageMetrics defaults missing fields to 0", () => {
		const handler = new MimoHandler(makeMimoOptions())
		const metrics = (handler as any).processUsageMetrics({})
		expect(metrics.inputTokens).toBe(0)
		expect(metrics.outputTokens).toBe(0)
		expect(metrics.cacheReadTokens).toBeUndefined()
	})

	it("uses default base URL when none specified", () => {
		const handler = new MimoHandler(makeMimoOptions())
		const config = (handler as any).config
		expect(config.baseURL).toBe("https://api.xiaomimimo.com/v1")
	})

	it("uses custom base URL when specified", () => {
		const handler = new MimoHandler(makeMimoOptions({ mimoBaseUrl: "https://custom.api.com/v1" }))
		const config = (handler as any).config
		expect(config.baseURL).toBe("https://custom.api.com/v1")
	})

	it("throws when API key is not provided", () => {
		expect(() => new MimoHandler(makeMimoOptions({ mimoApiKey: undefined } as any))).toThrow()
	})
})

describe("MimoTokenPlanHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("getModel returns default model when no apiModelId", () => {
		const handler = new MimoTokenPlanHandler(makeTokenPlanOptions())
		const result = handler.getModel()
		expect(result.id).toBe(mimoTokenPlanDefaultModelId)
		expect(result.info).toEqual(mimoTokenPlanModels[mimoTokenPlanDefaultModelId])
	})

	it("getModel returns specified model when valid model id provided", () => {
		const handler = new MimoTokenPlanHandler(makeTokenPlanOptions({ apiModelId: "mimo-v2-omni" }))
		const result = handler.getModel()
		expect(result.id).toBe("mimo-v2-omni")
		expect(result.info).toEqual(mimoTokenPlanModels["mimo-v2-omni"])
	})

	it("getModel falls back to default for unknown model id", () => {
		const handler = new MimoTokenPlanHandler(makeTokenPlanOptions({ apiModelId: "nonexistent-model" }))
		const result = handler.getModel()
		expect(result.info).toBeDefined()
	})

	it("uses fixed Token Plan base URL", () => {
		const handler = new MimoTokenPlanHandler(makeTokenPlanOptions())
		const config = (handler as any).config
		expect(config.baseURL).toBe("https://token-plan-cn.xiaomimimo.com/v1")
	})

	it("throws when API key is not provided", () => {
		expect(() => new MimoTokenPlanHandler(makeTokenPlanOptions({ mimoTokenPlanApiKey: undefined } as any))).toThrow()
	})
})

describe("MiMo Model Configuration", () => {
	it("mimo-v2.5-pro has correct properties", () => {
		const model = mimoModels["mimo-v2.5-pro"]
		expect(model.contextWindow).toBe(1_000_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsReasoningBudget).toBe(true)
	})

	it("mimo-v2-flash has correct properties", () => {
		const model = mimoModels["mimo-v2-flash"]
		expect(model.contextWindow).toBe(256_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsImages).toBe(false)
		expect(model.supportsReasoningBudget).toBe(true)
	})

	it("mimo-v2-pro Token Plan model has correct properties", () => {
		const model = mimoTokenPlanModels["mimo-v2-pro"]
		expect(model.contextWindow).toBe(1_000_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsReasoningBudget).toBe(true)
	})

	it("mimo-v2-omni Token Plan model supports images", () => {
		const model = mimoTokenPlanModels["mimo-v2-omni"]
		expect(model.supportsImages).toBe(true)
		expect(model.contextWindow).toBe(256_000)
	})
})
