import { describe, it, expect } from "vitest"
import { codebaseSearchTool } from "../CodebaseSearchTool"

describe("CodebaseSearchTool schema", () => {
	it("passes with valid input", () => {
		const result = codebaseSearchTool.inputSchema.safeParse({ query: "find users" })
		expect(result.success).toBe(true)
	})

	it("passes with optional path", () => {
		const result = codebaseSearchTool.inputSchema.safeParse({ query: "find users", path: "src" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = codebaseSearchTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty query", () => {
		const result = codebaseSearchTool.inputSchema.safeParse({ query: "" })
		expect(result.success).toBe(false)
	})
})
