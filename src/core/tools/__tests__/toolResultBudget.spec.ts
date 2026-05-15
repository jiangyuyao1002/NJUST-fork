import { describe, expect, it } from "vitest"

import { applyToolResultBudget, estimateTokens, getToolResultBudget, truncateToolResult } from "../toolResultBudget"

describe("tools/toolResultBudget", () => {
	it("computes sane budget bounds", () => {
		const budget = getToolResultBudget(200_000)
		expect(budget.singleMax).toBeGreaterThanOrEqual(500)
		expect(budget.totalMax).toBeGreaterThanOrEqual(500)
		expect(budget.singleMax).toBeLessThanOrEqual(30_000)
	})

	it("clamps very small context windows to the minimum budget", () => {
		expect(getToolResultBudget(0)).toEqual({ singleMax: 500, totalMax: 500 })
		expect(getToolResultBudget(4096)).toEqual({ singleMax: 614, totalMax: 1638 })
	})

	it("counts empty and non-empty text tokens", () => {
		expect(estimateTokens("")).toBe(0)
		expect(estimateTokens("hello world")).toBeGreaterThan(0)
	})

	it("does not truncate text that already fits the token budget", () => {
		expect(truncateToolResult("short result", 500)).toBe("short result")
		expect(truncateToolResult("", 500)).toBe("")
	})

	it("truncates long text and preserves head/tail with marker", () => {
		const long = `${"HEAD\n".repeat(500)}${"MIDDLE\n".repeat(3000)}${"TAIL\n".repeat(500)}`
		const out = truncateToolResult(long, 800)
		expect(out.length).toBeLessThan(long.length)
		expect(out).toContain("内容已裁剪")
		expect(out.startsWith("HEAD")).toBe(true)
		expect(out.includes("TAIL")).toBe(true)
	})

	it("compresses historical tool_result blocks, not current turn", () => {
		const huge = Array.from({ length: 2500 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n")
		const messages: any[] = [
			{ role: "user", content: "turn-1" },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: huge }] },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: huge }] }, // current turn
		]

		// Use a small context window so historical tool_result blocks exceed per-turn budget and compress.
		const out = applyToolResultBudget(messages as any, 12_000, 3)
		const hist = out[1].content[0].content as string
		const current = out[3].content[0].content as string

		expect(hist.length).toBeLessThan(huge.length)
		expect(hist).toContain("内容已裁剪")
		expect(current.length).toBe(huge.length)
	})
	it("compresses array text tool_result content while preserving non-text blocks", () => {
		const huge = Array.from({ length: 2500 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n")
		const messages: any[] = [
			{ role: "user", content: "turn-1" },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "a",
						content: [
							{ type: "text", text: huge },
							{ type: "document", source: { type: "text", media_type: "text/plain", data: "doc" } },
						],
					},
				],
			},
			{ role: "user", content: "turn-2" },
		]

		const out = applyToolResultBudget(messages as any, 12_000, 3)
		const content = out[1].content[0].content

		expect(content[0].type).toBe("text")
		expect(content[0].text.length).toBeLessThan(huge.length)
		expect(content[1].type).toBe("document")
	})

	it("does not compress tool_result content that contains images", () => {
		const huge = Array.from({ length: 2500 }, (_, i) => `line-${i} ${"x".repeat(40)}`).join("\n")
		const imageContent = [
			{ type: "text", text: huge },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
		]
		const messages: any[] = [
			{ role: "user", content: "turn-1" },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: imageContent }] },
			{ role: "user", content: "turn-2" },
		]

		const out = applyToolResultBudget(messages as any, 12_000, 3)

		expect(out[1].content[0].content).toBe(imageContent)
	})
})
