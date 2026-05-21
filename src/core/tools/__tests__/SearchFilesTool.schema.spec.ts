import { describe, it, expect } from "vitest"
import { searchFilesTool } from "../SearchFilesTool"

describe("SearchFilesTool schema", () => {
	it("passes with valid input", () => {
		const result = searchFilesTool.inputSchema.safeParse({ path: "src", regex: "foo" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = searchFilesTool.inputSchema.safeParse({ path: "src", regex: "foo", file_pattern: "*.ts" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = searchFilesTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty path", () => {
		const result = searchFilesTool.inputSchema.safeParse({ path: "", regex: "foo" })
		expect(result.success).toBe(false)
	})
})
