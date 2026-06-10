import { describe, it, expect } from "vitest"

import { summarizePromptCacheUsage } from "../cache-monitor"

describe("summarizePromptCacheUsage", () => {
	it("should format both read and create values", () => {
		const result = summarizePromptCacheUsage({
			cacheReadInputTokens: 100,
			cacheCreationInputTokens: 200,
		})

		expect(result).toBe("prompt-cache read=100 create=200")
	})

	it("should default to 0 for missing fields", () => {
		const result = summarizePromptCacheUsage({})

		expect(result).toBe("prompt-cache read=0 create=0")
	})

	it("should handle zero values explicitly", () => {
		const result = summarizePromptCacheUsage({
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		})

		expect(result).toBe("prompt-cache read=0 create=0")
	})
})
