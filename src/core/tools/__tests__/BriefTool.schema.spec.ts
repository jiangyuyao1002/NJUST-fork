import { describe, it, expect } from "vitest"
import { briefTool } from "../BriefTool"

describe("BriefTool schema", () => {
	it("passes with valid input", () => {
		const result = briefTool.inputSchema.safeParse({ content: "Some long content here" })
		expect(result.success).toBe(true)
	})

	it("passes with optional maxLength", () => {
		const result = briefTool.inputSchema.safeParse({ content: "Content", maxLength: 100 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = briefTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with wrong type for maxLength", () => {
		const result = briefTool.inputSchema.safeParse({ content: "Content", maxLength: "100" })
		expect(result.success).toBe(false)
	})
})
