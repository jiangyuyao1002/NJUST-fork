import { describe, it, expect } from "vitest"
import { listFilesTool } from "../ListFilesTool"

describe("ListFilesTool schema", () => {
	it("passes with valid input", () => {
		const result = listFilesTool.inputSchema.safeParse({ path: "src" })
		expect(result.success).toBe(true)
	})

	it("passes with optional recursive", () => {
		const result = listFilesTool.inputSchema.safeParse({ path: "src", recursive: true })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = listFilesTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty path", () => {
		const result = listFilesTool.inputSchema.safeParse({ path: "" })
		expect(result.success).toBe(false)
	})
})
