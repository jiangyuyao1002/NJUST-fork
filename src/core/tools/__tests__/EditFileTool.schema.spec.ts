import { describe, it, expect } from "vitest"
import { editFileTool } from "../EditFileTool"

describe("EditFileTool schema", () => {
	it("passes with valid input", () => {
		const result = editFileTool.inputSchema.safeParse({
			file_path: "test.txt",
			old_string: "old",
			new_string: "new",
		})
		expect(result.success).toBe(true)
	})

	it("passes with optional expected_replacements", () => {
		const result = editFileTool.inputSchema.safeParse({
			file_path: "test.txt",
			old_string: "old",
			new_string: "new",
			expected_replacements: 3,
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = editFileTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty file_path", () => {
		const result = editFileTool.inputSchema.safeParse({ file_path: "", old_string: "old", new_string: "new" })
		expect(result.success).toBe(false)
	})
})
