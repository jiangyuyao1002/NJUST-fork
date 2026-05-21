import { describe, it, expect } from "vitest"
import { webFetchTool } from "../WebFetchTool"

describe("WebFetchTool schema", () => {
	it("passes with valid input", () => {
		const result = webFetchTool.inputSchema.safeParse({ url: "https://example.com" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = webFetchTool.inputSchema.safeParse({ url: "https://example.com", format: "json", maxLength: 5000 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = webFetchTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with invalid url", () => {
		const result = webFetchTool.inputSchema.safeParse({ url: "not-a-url" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid format enum", () => {
		const result = webFetchTool.inputSchema.safeParse({ url: "https://example.com", format: "xml" })
		expect(result.success).toBe(false)
	})
})
