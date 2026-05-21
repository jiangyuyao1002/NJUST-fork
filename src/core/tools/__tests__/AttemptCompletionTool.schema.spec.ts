import { describe, it, expect } from "vitest"
import { attemptCompletionTool } from "../AttemptCompletionTool"

describe("AttemptCompletionTool schema", () => {
	it("passes with valid input", () => {
		const result = attemptCompletionTool.inputSchema.safeParse({ result: "Task completed successfully" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = attemptCompletionTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty result", () => {
		const result = attemptCompletionTool.inputSchema.safeParse({ result: "" })
		expect(result.success).toBe(false)
	})
})
