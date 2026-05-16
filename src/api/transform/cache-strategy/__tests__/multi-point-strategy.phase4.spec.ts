import { describe, expect, it, vi } from "vitest"

vi.mock("../../../../utils/logging", () => ({
	logger: {
		info: vi.fn(),
	},
}))

import { MultiPointStrategy } from "../multi-point-strategy"
import type { CacheStrategyConfig, ModelInfo } from "../types"

const modelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsPromptCache: true,
	maxCachePoints: 3,
	minTokensPerCachePoint: 20,
	cachableFields: ["system", "messages"],
}

function longText(words: number) {
	return Array.from({ length: words }, (_, i) => `word${i}`).join(" ")
}

function config(overrides: Partial<CacheStrategyConfig> = {}): CacheStrategyConfig {
	return {
		modelInfo,
		messages: [],
		systemPrompt: "",
		usePromptCache: true,
		...overrides,
	}
}

function hasCachePoint(block: unknown): boolean {
	return Boolean(block && typeof block === "object" && "cachePoint" in block)
}

describe("MultiPointStrategy phase4 coverage", () => {
	it("returns plain result when prompt cache is disabled", () => {
		const strategy = new MultiPointStrategy(
			config({
				usePromptCache: false,
				systemPrompt: "system",
				messages: [{ role: "user", content: longText(30) }],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.system).toEqual([{ text: "system" }])
		expect(result.messageCachePointPlacements).toBeUndefined()
		expect(result.messages[0].content?.some(hasCachePoint)).toBe(false)
	})

	it("adds system cache only when message caching is unsupported", () => {
		const strategy = new MultiPointStrategy(
			config({
				systemPrompt: longText(40),
				modelInfo: { ...modelInfo, cachableFields: ["system"], minTokensPerCachePoint: 5 },
				messages: [{ role: "user", content: longText(40) }],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.system).toHaveLength(2)
		expect(hasCachePoint(result.system[1])).toBe(true)
		expect(result.messageCachePointPlacements).toBeUndefined()
	})

	it("places initial cache point on last user message in eligible range", () => {
		const strategy = new MultiPointStrategy(
			config({
				messages: [
					{ role: "user", content: longText(30) },
					{ role: "assistant", content: longText(5) },
					{ role: "user", content: longText(30) },
					{ role: "assistant", content: "done" },
				],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.messageCachePointPlacements?.[0]).toMatchObject({ index: 2, type: "message" })
		expect(result.messages[2].content?.some(hasCachePoint)).toBe(true)
	})

	it("keeps previous placements when new messages are below threshold", () => {
		const strategy = new MultiPointStrategy(
			config({
				previousCachePointPlacements: [{ index: 0, type: "message", tokensCovered: 50 }],
				messages: [
					{ role: "user", content: longText(30) },
					{ role: "assistant", content: "short" },
				],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.messageCachePointPlacements).toEqual([{ index: 0, type: "message", tokensCovered: 50 }])
	})

	it("drops previous placements that point beyond current messages", () => {
		const strategy = new MultiPointStrategy(
			config({
				previousCachePointPlacements: [
					{ index: 0, type: "message", tokensCovered: 50 },
					{ index: 9, type: "message", tokensCovered: 50 },
				],
				messages: [
					{ role: "user", content: longText(30) },
					{ role: "assistant", content: "short" },
				],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.messageCachePointPlacements).toEqual([{ index: 0, type: "message", tokensCovered: 50 }])
	})

	it("does not place cache point when range has no user message", () => {
		const strategy = new MultiPointStrategy(
			config({
				messages: [
					{ role: "assistant", content: longText(30) },
					{ role: "assistant", content: longText(30) },
				],
			}),
		)

		const result = strategy.determineOptimalCachePoints()

		expect(result.messageCachePointPlacements).toEqual([])
	})
})
