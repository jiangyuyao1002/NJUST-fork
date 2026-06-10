import { describe, expect, it } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import { CacheStrategy } from "../base-strategy"
import type { CacheResult, CacheStrategyConfig } from "../types"

const modelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsPromptCache: true,
	maxCachePoints: 4,
	minTokensPerCachePoint: 10,
	cachableFields: ["system", "messages", "tools"] as Array<"system" | "messages" | "tools">,
}

class ExposedStrategy extends CacheStrategy {
	public determineOptimalCachePoints(): CacheResult {
		return this.formatResult([], [])
	}

	public exposeMessages(messages: Anthropic.Messages.MessageParam[]) {
		return this.messagesToContentBlocks(messages)
	}

	public exposeEstimate(message: Anthropic.Messages.MessageParam) {
		return this.estimateTokenCount(message)
	}

	public exposeMeetsMin(tokenCount: number) {
		return this.meetsMinTokenThreshold(tokenCount)
	}

	public exposeApply(
		messages: ReturnType<ExposedStrategy["exposeMessages"]>,
		placements: Array<{ index: number; type: "message"; tokensCovered: number }>,
	) {
		return this.applyCachePoints(messages, placements)
	}
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

describe("CacheStrategy base behavior", () => {
	it("estimates zero tokens for empty content", () => {
		const strategy = new ExposedStrategy(config())

		expect(strategy.exposeEstimate({ role: "user", content: "" })).toBe(0)
	})

	it("estimates text, punctuation, and newline overhead", () => {
		const strategy = new ExposedStrategy(config())

		expect(strategy.exposeEstimate({ role: "user", content: "hello, world!\nagain" })).toBeGreaterThan(13)
	})

	it("adds conservative token estimate for images", () => {
		const strategy = new ExposedStrategy(config())

		const tokens = strategy.exposeEstimate({
			role: "user",
			content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
		} as Anthropic.Messages.MessageParam)

		expect(tokens).toBe(310)
	})

	it("converts text and unsupported blocks to Bedrock content blocks", () => {
		const strategy = new ExposedStrategy(config())

		const messages = strategy.exposeMessages([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: {} }] as any },
		])

		expect(messages).toEqual([
			{ role: "user", content: [{ text: "hello" }] },
			{ role: "assistant", content: [{ text: "[Unsupported Content]" }] },
		])
	})

	it("checks minimum token threshold from model info", () => {
		const strategy = new ExposedStrategy(config())

		expect(strategy.exposeMeetsMin(9)).toBe(false)
		expect(strategy.exposeMeetsMin(10)).toBe(true)
	})

	it("returns false when model has no minimum cache threshold", () => {
		const strategy = new ExposedStrategy(config({ modelInfo: { ...modelInfo, minTokensPerCachePoint: 0 } }))

		expect(strategy.exposeMeetsMin(100)).toBe(false)
	})

	it("applies cache points at requested message indexes", () => {
		const strategy = new ExposedStrategy(config())
		const messages = strategy.exposeMessages([
			{ role: "user", content: "one" },
			{ role: "assistant", content: "two" },
		])

		const result = strategy.exposeApply(messages, [{ index: 0, type: "message", tokensCovered: 10 }])

		expect(result[0].content?.at(-1)).toEqual({ cachePoint: { type: "default" } })
		expect(result[1].content).toEqual([{ text: "two" }])
	})
})
