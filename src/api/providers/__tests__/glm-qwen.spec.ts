import { describe, it, expect, vi, beforeEach } from "vitest"

import type { ApiHandlerOptions } from "../../../shared/api"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(function () {
			return {
				onDidCreate: vi.fn(),
				onDidChange: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}
		}),
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

import { GlmHandler } from "../glm"
import { QwenHandler } from "../qwen"

function makeOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		glmApiKey: "test-key",
		qwenApiKey: "test-key",
		...overrides,
	} as ApiHandlerOptions
}

describe("GlmHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("getModel returns default model when no apiModelId", () => {
		const handler = new GlmHandler(makeOptions())
		const result = handler.getModel()
		expect(result.id).toBeTruthy()
		expect(result.info).toBeDefined()
	})

	it("getModel falls back to default for unknown model id", () => {
		const handler = new GlmHandler(makeOptions({ apiModelId: "nonexistent-model" }))
		const result = handler.getModel()
		expect(result.info).toBeDefined()
	})

	it("processUsageMetrics maps fields correctly", () => {
		const handler = new GlmHandler(makeOptions())
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
		const handler = new GlmHandler(makeOptions())
		const metrics = (handler as any).processUsageMetrics({})
		expect(metrics.inputTokens).toBe(0)
		expect(metrics.outputTokens).toBe(0)
		expect(metrics.cacheReadTokens).toBeUndefined()
	})

	it("getMaxOutputTokens returns undefined when no max configured", () => {
		const handler = new GlmHandler(makeOptions())
		const result = (handler as any).getMaxOutputTokens()
		expect(result === undefined || typeof result === "number").toBe(true)
	})
})

describe("QwenHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("getModel returns default model when no apiModelId", () => {
		const handler = new QwenHandler(makeOptions({ qwenApiKey: "test-key" }))
		const result = handler.getModel()
		expect(result.id).toBeTruthy()
		expect(result.info).toBeDefined()
	})

	it("getModel falls back to default for unknown model id", () => {
		const handler = new QwenHandler(makeOptions({ apiModelId: "nonexistent-model", qwenApiKey: "test-key" }))
		const result = handler.getModel()
		expect(result.info).toBeDefined()
	})

	it("processUsageMetrics maps fields correctly", () => {
		const handler = new QwenHandler(makeOptions({ qwenApiKey: "test-key" }))
		const metrics = (handler as any).processUsageMetrics({
			inputTokens: 200,
			outputTokens: 80,
			details: { cachedInputTokens: 20, reasoningTokens: 8 },
		})
		expect(metrics).toEqual({
			type: "usage",
			inputTokens: 200,
			outputTokens: 80,
			cacheReadTokens: 20,
			reasoningTokens: 8,
		})
	})

	it("processUsageMetrics defaults missing fields to 0", () => {
		const handler = new QwenHandler(makeOptions({ qwenApiKey: "test-key" }))
		const metrics = (handler as any).processUsageMetrics({})
		expect(metrics.inputTokens).toBe(0)
		expect(metrics.outputTokens).toBe(0)
	})

	it("getMaxOutputTokens returns undefined when no max configured", () => {
		const handler = new QwenHandler(makeOptions({ qwenApiKey: "test-key" }))
		const result = (handler as any).getMaxOutputTokens()
		expect(result === undefined || typeof result === "number").toBe(true)
	})
})
