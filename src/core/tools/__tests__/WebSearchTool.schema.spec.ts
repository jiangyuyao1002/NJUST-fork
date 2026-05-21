import { describe, it, expect } from "vitest"
import { webSearchTool } from "../WebSearchTool"

describe("WebSearchTool schema", () => {
	it("passes with valid input", () => {
		const result = webSearchTool.inputSchema.safeParse({ search_query: "test query" })
		expect(result.success).toBe(true)
	})

	it("passes with optional count", () => {
		const result = webSearchTool.inputSchema.safeParse({ search_query: "test", count: 10 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = webSearchTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty search_query", () => {
		const result = webSearchTool.inputSchema.safeParse({ search_query: "" })
		expect(result.success).toBe(false)
	})
})
