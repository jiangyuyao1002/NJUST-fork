import { describe, expect, it } from "vitest"

import {
	DEFAULT_PROMPT_BOUNDARY,
	applyPromptBudget,
	estimatePromptTokens,
	renderPrompt,
	type PromptSection,
} from "../index.js"

describe("prompt-engine renderer", () => {
	it("renders static and dynamic sections with a stable boundary", () => {
		const prompt = renderPrompt({
			staticSections: [
				{ name: "role", text: "Role" },
				{ name: "tools", text: "Tools" },
			],
			dynamicSections: [
				{ name: "objective", text: "Objective" },
				{ name: "system", text: "System" },
			],
		})

		expect(prompt.staticPart).toBe("Role\n\nTools")
		expect(prompt.dynamicPart).toBe("Objective\n\nSystem")
		expect(prompt.fullPrompt).toBe(`Role\n\nTools${DEFAULT_PROMPT_BOUNDARY}Objective\n\nSystem`)
	})

	it("filters blank sections before rendering", () => {
		const sections: PromptSection[] = [
			{ name: "blank", text: "" },
			{ name: "space", text: "   " },
			{ name: "real", text: "Real" },
		]

		expect(renderPrompt({ staticSections: sections, dynamicSections: [] }).staticPart).toBe("Real")
	})

	it("trims optional sections by priority while keeping required sections", () => {
		const result = renderPrompt({
			staticSections: [{ name: "role", text: "Role", required: true }],
			dynamicSections: [
				{ name: "low", text: "x".repeat(400), priority: 0 },
				{ name: "high", text: "Keep me", priority: 5 },
			],
			maxPromptTokens: 4,
		})

		expect(result.retainedSectionNames.has("role")).toBe(true)
		expect(result.retainedSectionNames.has("high")).toBe(true)
		expect(result.retainedSectionNames.has("low")).toBe(false)
		expect(result.dynamicPart).toContain("Keep me")
	})

	it("estimates tokens and trims dynamic text before static text", () => {
		const budgeted = applyPromptBudget("Static", ["Dynamic ".repeat(100)], 40)

		expect(estimatePromptTokens("abc abc abc")).toBeGreaterThan(0)
		expect(budgeted.staticPart).toBe("Static")
		expect(budgeted.dynamicPart).toContain("Prompt section truncated")
	})

	it("keeps prompt unchanged when no budget is supplied", () => {
		const budgeted = applyPromptBudget("Static", "Dynamic")

		expect(budgeted).toEqual({ staticPart: "Static", dynamicPart: "Dynamic" })
	})

	it("omits dynamic content when static content exceeds the whole budget", () => {
		const budgeted = applyPromptBudget("Static ".repeat(100), "Dynamic", 4)

		expect(budgeted.staticPart).toContain("Prompt section truncated")
		expect(budgeted.dynamicPart).toBe("[Dynamic prompt omitted due to token budget]")
	})

	it("keeps every section when the token budget is large enough", () => {
		const result = renderPrompt({
			staticSections: [{ name: "role", text: "Role" }],
			dynamicSections: [{ name: "objective", text: "Objective" }],
			maxPromptTokens: 1000,
		})

		expect(result.retainedSectionNames).toEqual(new Set(["role", "objective"]))
		expect(result.fullPrompt).toContain(DEFAULT_PROMPT_BOUNDARY)
	})

	it("counts CJK text more heavily than empty text", () => {
		expect(estimatePromptTokens("仓颉语言")).toBeGreaterThan(estimatePromptTokens(""))
	})
})
