import { describe, it, expect } from "vitest"
import { taskGetTool } from "../TaskGetTool"

describe("TaskGetTool schema", () => {
	it("passes with valid input", () => {
		const result = taskGetTool.inputSchema.safeParse({ taskId: "task-123" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = taskGetTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty taskId", () => {
		const result = taskGetTool.inputSchema.safeParse({ taskId: "" })
		expect(result.success).toBe(false)
	})
})
