import { describe, it, expect } from "vitest"
import { notebookEditTool } from "../NotebookEditTool"

describe("NotebookEditTool schema", () => {
	it("passes with valid insert", () => {
		const result = notebookEditTool.inputSchema.safeParse({
			path: "test.ipynb",
			action: "insert",
			cellIndex: 0,
			content: "print('hello')",
		})
		expect(result.success).toBe(true)
	})

	it("passes with valid delete", () => {
		const result = notebookEditTool.inputSchema.safeParse({ path: "test.ipynb", action: "delete", cellIndex: 0 })
		expect(result.success).toBe(true)
	})

	it("fails when content is missing for insert", () => {
		const result = notebookEditTool.inputSchema.safeParse({ path: "test.ipynb", action: "insert", cellIndex: 0 })
		expect(result.success).toBe(false)
	})

	it("fails with invalid action enum", () => {
		const result = notebookEditTool.inputSchema.safeParse({ path: "test.ipynb", action: "move", cellIndex: 0 })
		expect(result.success).toBe(false)
	})
})
