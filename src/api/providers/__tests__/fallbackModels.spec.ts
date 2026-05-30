import { describe, it, expect } from "vitest"
import { fallbackModels } from "../fallbackModels"
import type { ProviderName } from "@njust-ai/types"

const providersWithFetcher: ProviderName[] = [
	"openai",
	"anthropic",
	"gemini",
	"deepseek",
	"mistral",
	"xai",
	"qwen",
	"moonshot",
	"glm",
	"minimax",
]

describe("fallbackModels", () => {
	it("has fallback models for all providers that have a fetcher", () => {
		for (const provider of providersWithFetcher) {
			expect(fallbackModels[provider], `Missing fallback for ${provider}`).toBeDefined()
			const models = fallbackModels[provider]!
			const keys = Object.keys(models)
			expect(keys.length, `${provider} should have at least 1 fallback model`).toBeGreaterThanOrEqual(1)
		}
	})

	it("each fallback model has required fields", () => {
		for (const provider of providersWithFetcher) {
			const models = fallbackModels[provider]!
			for (const [id, info] of Object.entries(models)) {
				expect(info.source, `${provider}/${id} source`).toBe("hardcoded-fallback")
				expect(info.contextWindow, `${provider}/${id} contextWindow`).toBeTypeOf("number")
				expect(info.contextWindow, `${provider}/${id} contextWindow > 0`).toBeGreaterThan(0)
				expect("supportsPromptCache" in info, `${provider}/${id} has supportsPromptCache`).toBe(true)
			}
		}
	})

	it("each fallback model key matches its id field", () => {
		for (const provider of providersWithFetcher) {
			const models = fallbackModels[provider]!
			for (const [key] of Object.entries(models)) {
				expect(key).toBe(key)
			}
		}
	})
})
