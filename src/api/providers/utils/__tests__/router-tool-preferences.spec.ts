import { describe, it, expect } from "vitest"

import { applyRouterToolPreferences } from "../router-tool-preferences"

describe("applyRouterToolPreferences", () => {
	const baseInfo = {
		contextWindow: 128000,
		supportsPromptCache: false,
		maxTokens: null,
		maxThinkingTokens: null,
	}

	it("should add excludedTools and includedTools for OpenAI models", () => {
		const result = applyRouterToolPreferences("openai/gpt-4o", baseInfo)

		expect(result.excludedTools).toContain("write_to_file")
		expect(result.includedTools).toContain("apply_patch")
	})

	it("should return unchanged model info for non-OpenAI models", () => {
		const result = applyRouterToolPreferences("google/gemini-2.5-pro", baseInfo)

		expect(result.excludedTools).toBeUndefined()
		expect(result.includedTools).toBeUndefined()
	})

	it("should preserve existing excludedTools when adding OpenAI preferences", () => {
		const info = { ...baseInfo, excludedTools: ["browser_action"] }
		const result = applyRouterToolPreferences("openai/gpt-4", info)

		expect(result.excludedTools).toContain("browser_action")
		expect(result.excludedTools).toContain("write_to_file")
	})
})
