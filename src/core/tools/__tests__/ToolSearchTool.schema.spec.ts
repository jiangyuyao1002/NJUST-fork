import { describe, it, expect } from "vitest"
import { toolSearchTool } from "../ToolSearchTool"

describe("ToolSearchTool schema", () => {
	it("passes with valid input", () => {
		const result = toolSearchTool.inputSchema.safeParse({ query: "search term" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = toolSearchTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty query", () => {
		const result = toolSearchTool.inputSchema.safeParse({ query: "" })
		expect(result.success).toBe(false)
	})
})
