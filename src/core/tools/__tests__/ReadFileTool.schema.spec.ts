import { describe, it, expect } from "vitest"
import { readFileTool } from "../ReadFileTool"

describe("ReadFileTool schema", () => {
	it("passes with valid input", () => {
		const result = readFileTool.inputSchema.safeParse({ path: "test.txt" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = readFileTool.inputSchema.safeParse({ path: "test.txt", offset: 1, limit: 50 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = readFileTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty path", () => {
		const result = readFileTool.inputSchema.safeParse({ path: "" })
		expect(result.success).toBe(false)
	})
})
