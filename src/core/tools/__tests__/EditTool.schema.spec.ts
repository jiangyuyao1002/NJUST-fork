import { describe, it, expect } from "vitest"
import { editTool } from "../EditTool"

describe("EditTool schema", () => {
	it("passes with valid input", () => {
		const result = editTool.inputSchema.safeParse({ file_path: "test.txt", old_string: "old", new_string: "new" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = editTool.inputSchema.safeParse({
			file_path: "test.txt",
			old_string: "old",
			new_string: "new",
			replace_all: true,
			expected_replacements: 2,
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = editTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty file_path", () => {
		const result = editTool.inputSchema.safeParse({ file_path: "", old_string: "old", new_string: "new" })
		expect(result.success).toBe(false)
	})
})
