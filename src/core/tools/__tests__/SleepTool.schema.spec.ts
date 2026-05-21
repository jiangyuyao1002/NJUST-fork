import { describe, it, expect } from "vitest"
import { sleepTool } from "../SleepTool"

describe("SleepTool schema", () => {
	it("passes with valid input", () => {
		const result = sleepTool.inputSchema.safeParse({ seconds: 5 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = sleepTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with wrong type", () => {
		const result = sleepTool.inputSchema.safeParse({ seconds: "five" })
		expect(result.success).toBe(false)
	})

	it("fails with negative number", () => {
		const result = sleepTool.inputSchema.safeParse({ seconds: -1 })
		expect(result.success).toBe(false)
	})
})
