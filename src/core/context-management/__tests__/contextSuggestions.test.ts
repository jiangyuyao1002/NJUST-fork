import { describe, it, expect } from "vitest"
import { generateSuggestions, formatSuggestions } from "../contextSuggestions"
import type { TokenBreakdown } from "../contextAnalysis"

function mkBd(o: Partial<TokenBreakdown> = {}): TokenBreakdown {
	return {
		totalTokens: 10000,
		systemPromptTokens: 1000,
		toolUseTokens: 2000,
		toolResultTokens: 4000,
		summaryTokens: 1000,
		otherTokens: 2000,
		...o,
	}
}

describe("generateSuggestions", () => {
	it("returns empty for zero total tokens", () => {
		expect(generateSuggestions(mkBd({ totalTokens: 0 }), [], 0, [], 0)).toEqual([])
	})

	it("warns when tool results > 60 percent with large results", () => {
		const r = generateSuggestions(
			mkBd({ toolResultTokens: 7000 }),
			[],
			0,
			[{ estimatedTokens: 3000, toolName: "read" }],
			0,
		)
		expect(r.some((s) => s.type === "warning" && s.message.includes("70"))).toBe(true)
	})

	it("infos when tool results > 40 percent but <= 60", () => {
		const r = generateSuggestions(mkBd({ toolResultTokens: 5000 }), [], 0, [], 0)
		expect(r.some((s) => s.type === "info" && s.message.includes("50"))).toBe(true)
	})

	it("tips about summary chain when > 30 percent and >= 2 summaries", () => {
		const r = generateSuggestions(mkBd({ summaryTokens: 4000 }), [], 0, [], 2)
		expect(r.some((s) => s.type === "tip" && s.message.includes("summary"))).toBe(true)
	})

	it("warns about duplicate reads > 20 percent", () => {
		const r = generateSuggestions(mkBd(), [{ filePath: "a.ts", readCount: 3 }], 3000, [], 0)
		expect(r.some((s) => s.type === "warning" && s.message.includes("Re-reading"))).toBe(true)
	})

	it("infos about high tool use proportion > 30 percent", () => {
		const r = generateSuggestions(mkBd({ toolUseTokens: 4000 }), [], 0, [], 0)
		expect(r.some((s) => s.type === "info" && s.message.includes("Tool call"))).toBe(true)
	})

	it("warns about very large individual results", () => {
		const r = generateSuggestions(mkBd(), [], 0, [{ estimatedTokens: 6000, toolName: "list" }], 0)
		expect(r.some((s) => s.type === "warning" && s.message.includes("5K"))).toBe(true)
	})

	it("tips when 3+ accumulated summaries", () => {
		const r = generateSuggestions(mkBd(), [], 0, [], 3)
		expect(r.some((s) => s.type === "tip" && s.message.includes("accumulated"))).toBe(true)
	})

	it("returns empty when no thresholds met", () => {
		const r = generateSuggestions(
			mkBd({ toolResultTokens: 1000, toolUseTokens: 1000, summaryTokens: 100 }),
			[],
			0,
			[],
			0,
		)
		expect(r).toEqual([])
	})
})

describe("formatSuggestions", () => {
	it("returns empty string for empty array", () => {
		expect(formatSuggestions([])).toBe("")
	})

	it("formats warning with exclamation", () => {
		const s = formatSuggestions([{ type: "warning", message: "test" }])
		expect(s).toContain("[!]")
		expect(s).toContain("test")
	})

	it("formats info with i", () => {
		const s = formatSuggestions([{ type: "info", message: "note" }])
		expect(s).toContain("[i]")
	})

	it("formats tip with question mark", () => {
		const s = formatSuggestions([{ type: "tip", message: "hint" }])
		expect(s).toContain("[?]")
	})

	it("includes detail when present", () => {
		const s = formatSuggestions([{ type: "warning", message: "m", detail: "d" }])
		expect(s).toContain("d")
	})

	it("joins multiple suggestions with newlines", () => {
		const s = formatSuggestions([
			{ type: "info", message: "a" },
			{ type: "tip", message: "b" },
		])
		expect(s).toContain(String.fromCharCode(10))
	})
})
