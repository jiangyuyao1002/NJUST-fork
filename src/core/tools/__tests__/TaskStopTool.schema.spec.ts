import { describe, it, expect } from "vitest"
import { taskStopTool } from "../TaskStopTool"

describe("TaskStopTool schema", () => {
	it("passes with valid input", () => {
		const result = taskStopTool.inputSchema.safeParse({ taskId: "task-123" })
		expect(result.success).toBe(true)
	})

	it("passes with optional reason", () => {
		const result = taskStopTool.inputSchema.safeParse({ taskId: "task-123", reason: "User request" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = taskStopTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty taskId", () => {
		const result = taskStopTool.inputSchema.safeParse({ taskId: "" })
		expect(result.success).toBe(false)
	})
})
