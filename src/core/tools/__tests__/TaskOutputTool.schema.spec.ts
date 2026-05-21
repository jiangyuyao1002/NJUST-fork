import { describe, it, expect } from "vitest"
import { taskOutputTool } from "../TaskOutputTool"

describe("TaskOutputTool schema", () => {
	it("passes with valid input", () => {
		const result = taskOutputTool.inputSchema.safeParse({ taskId: "task-123" })
		expect(result.success).toBe(true)
	})

	it("passes with optional pagination", () => {
		const result = taskOutputTool.inputSchema.safeParse({ taskId: "task-123", offset: 10, limit: 50 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = taskOutputTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty taskId", () => {
		const result = taskOutputTool.inputSchema.safeParse({ taskId: "" })
		expect(result.success).toBe(false)
	})
})
