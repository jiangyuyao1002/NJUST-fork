import { describe, it, expect } from "vitest"
import { grepTool } from "../GrepTool"

describe("GrepTool schema", () => {
	it("passes with valid input", () => {
		const result = grepTool.inputSchema.safeParse({ pattern: "foo" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = grepTool.inputSchema.safeParse({ pattern: "foo", path: "src", include: "*.ts" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = grepTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty pattern", () => {
		const result = grepTool.inputSchema.safeParse({ pattern: "" })
		expect(result.success).toBe(false)
	})
})
