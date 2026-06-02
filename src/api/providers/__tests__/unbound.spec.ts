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

vi.mock("openai", () => ({
	default: vi.fn(function () {
		return {
			chat: { completions: { create: vi.fn() } },
		}
	}),
}))

vi.mock("../fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
}))

import { UnboundHandler } from "../unbound"

function makeOptions(overrides: Partial<ApiHandlerOptions> = {}): ApiHandlerOptions {
	return {
		unboundApiKey: "test-key",
		unboundModelId: "test-model",
		...overrides,
	} as ApiHandlerOptions
}

describe("UnboundHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("getModel returns configured model id", () => {
		const handler = new UnboundHandler(makeOptions())
		const result = handler.getModel()
		expect(result.id).toBe("test-model")
		expect(result.info).toBeDefined()
	})

	it("getModel falls back to default model", () => {
		const handler = new UnboundHandler(makeOptions({ unboundModelId: undefined } as any))
		const result = handler.getModel()
		expect(result.id).toBeTruthy()
	})

	it("processUsageMetrics maps all fields including cache tokens", () => {
		const handler = new UnboundHandler(makeOptions())
		const usage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			cache_creation_input_tokens: 10,
			cache_read_input_tokens: 5,
		}
		const metrics = (handler as any).processUsageMetrics(usage)
		expect(metrics.type).toBe("usage")
		expect(metrics.inputTokens).toBe(100)
		expect(metrics.outputTokens).toBe(50)
		expect(metrics.cacheWriteTokens).toBe(10)
		expect(metrics.cacheReadTokens).toBe(5)
	})

	it("processUsageMetrics defaults to 0 when no usage", () => {
		const handler = new UnboundHandler(makeOptions())
		const metrics = (handler as any).processUsageMetrics({})
		expect(metrics.inputTokens).toBe(0)
		expect(metrics.outputTokens).toBe(0)
		expect(metrics.cacheWriteTokens).toBe(0)
		expect(metrics.cacheReadTokens).toBe(0)
	})

	it("processUsageMetrics calculates cost when modelInfo provided", () => {
		const handler = new UnboundHandler(makeOptions())
		const modelInfo = {
			inputPrice: 0.5,
			outputPrice: 1.5,
			cacheWritesPrice: 0.1,
			cacheReadsPrice: 0.05,
		}
		const metrics = (handler as any).processUsageMetrics({ prompt_tokens: 1000, completion_tokens: 500 }, modelInfo)
		expect(metrics.totalCost).toBeGreaterThan(0)
	})

	it("processUsageMetrics returns zero cost without modelInfo", () => {
		const handler = new UnboundHandler(makeOptions())
		const metrics = (handler as any).processUsageMetrics({ prompt_tokens: 100, completion_tokens: 50 }, undefined)
		expect(metrics.totalCost).toBe(0)
	})

	it("shouldUseStrictMode returns false", () => {
		const handler = new UnboundHandler(makeOptions())
		expect((handler as any).shouldUseStrictMode()).toBe(false)
	})
})
