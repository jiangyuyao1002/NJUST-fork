// npx vitest run src/api/providers/__tests__/doubao.spec.ts

import { describe, it, expect } from "vitest"

const THINKING_MODEL_PATTERNS = [/doubao-(?!.*non-).*-thinking/, /seed-1\.6/, /seed-2\.0/]

function isThinkingModel(modelId: string): boolean {
	return THINKING_MODEL_PATTERNS.some((p) => p.test(modelId))
}

describe("doubao thinking model detection", () => {
	it("should match thinking models", () => {
		expect(isThinkingModel("doubao-pro-thinking")).toBe(true)
		expect(isThinkingModel("doubao-lite-thinking")).toBe(true)
		expect(isThinkingModel("seed-1.6-flash")).toBe(true)
		expect(isThinkingModel("seed-2.0-pro")).toBe(true)
	})

	it("should not match non-thinking models", () => {
		expect(isThinkingModel("doubao-pro-32k")).toBe(false)
		expect(isThinkingModel("doubao-non-thinking-pro")).toBe(false)
		expect(isThinkingModel("doubao-pro")).toBe(false)
	})
})
