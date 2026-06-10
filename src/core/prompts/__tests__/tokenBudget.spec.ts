import { describe, expect, it } from "vitest"

import {
	applySystemPromptBudget,
	derivePromptTokenBudget,
	mergeDynamicPromptSegmentsByTokenBudget,
} from "../tokenBudget"

describe("prompt token budget", () => {
	it("derives ratio-based budgets from context window", () => {
		const b = derivePromptTokenBudget(100_000)
		expect(b).not.toBeNull()
		expect(b!.systemPromptMaxTokens).toBe(15_000)
		expect(b!.toolDefinitionMaxTokens).toBe(10_000)
		expect(b!.dialogHistoryMinTokens).toBe(50_000)
	})

	it("keeps minimum floors for small context windows", () => {
		const b = derivePromptTokenBudget(8_000)
		expect(b).not.toBeNull()
		expect(b!.systemPromptMaxTokens).toBe(1200)
		expect(b!.toolDefinitionMaxTokens).toBe(800)
		expect(b!.dialogHistoryMinTokens).toBe(4000)
	})

	it("returns null for invalid context window", () => {
		expect(derivePromptTokenBudget(undefined)).toBeNull()
		expect(derivePromptTokenBudget(0)).toBeNull()
		expect(derivePromptTokenBudget(-1)).toBeNull()
	})

	it("does not change prompt when within budget", () => {
		const staticPart = "short static"
		const dynamicPart = "short dynamic"
		const out = applySystemPromptBudget(staticPart, dynamicPart, 100_000)
		expect(out.staticPart).toBe(staticPart)
		expect(out.dynamicPart).toBe(dynamicPart)
	})

	it("truncates dynamic part first when prompt exceeds budget", () => {
		const staticPart = "S".repeat(20_000)
		const dynamicPart = "D".repeat(80_000)
		const out = applySystemPromptBudget(staticPart, dynamicPart, 100_000)
		expect(out.staticPart).toBe(staticPart)
		expect(out.dynamicPart.length).toBeLessThan(dynamicPart.length)
		expect(out.dynamicPart).toContain("[Prompt section truncated due to token budget]")
	})

	it("truncates static and drops dynamic marker when static alone exceeds budget", () => {
		const staticPart = "S".repeat(90_000)
		const dynamicPart = "D".repeat(10_000)
		const out = applySystemPromptBudget(staticPart, dynamicPart, 20_000)
		expect(out.staticPart.length).toBeLessThan(staticPart.length)
		expect(out.staticPart).toContain("[Prompt section truncated due to token budget]")
		expect(out.dynamicPart).toBe("[Dynamic prompt omitted due to token budget]")
	})

	it("preserves higher-priority dynamic segments when budget is tight", () => {
		const staticPart = "S".repeat(20_000)
		const hi = "HIGH_PRIORITY".repeat(100)
		const lo = "LOW_PRIORITY".repeat(10_000)
		const out = applySystemPromptBudget(staticPart, [hi, lo], 100_000)
		expect(out.dynamicPart).toContain("HIGH_PRIORITY")
		expect(out.dynamicPart.indexOf("HIGH_PRIORITY")).toBeLessThan(out.dynamicPart.indexOf("LOW_PRIORITY"))
	})

	it("mergeDynamicPromptSegmentsByTokenBudget fills earliest segments first", () => {
		const a = "A".repeat(100)
		const b = "B".repeat(100)
		// Exactly enough tokens for the first segment only (~29 tokens for 100 chars)
		const merged = mergeDynamicPromptSegmentsByTokenBudget([a, b], 29)
		expect(merged).toBe(a)
		expect(merged.includes("B")).toBe(false)
	})
})
