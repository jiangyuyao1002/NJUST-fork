import { describe, it, expect } from "vitest"
import { askFollowupQuestionTool } from "../AskFollowupQuestionTool"

describe("AskFollowupQuestionTool schema", () => {
	it("passes with valid input", () => {
		const result = askFollowupQuestionTool.inputSchema.safeParse({
			question: "What is your name?",
			follow_up: [{ text: "Option 1" }, { text: "Option 2", mode: "code" }],
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = askFollowupQuestionTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with wrong type for follow_up", () => {
		const result = askFollowupQuestionTool.inputSchema.safeParse({
			question: "What?",
			follow_up: "not an array",
		})
		expect(result.success).toBe(false)
	})
})
