import { describe, it, expect } from "vitest"
import { taskUpdateTool } from "../TaskUpdateTool"

describe("TaskUpdateTool schema", () => {
	it("passes with valid input", () => {
		const result = taskUpdateTool.inputSchema.safeParse({ taskId: "task-123" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = taskUpdateTool.inputSchema.safeParse({ taskId: "task-123", status: "completed", priority: "high" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = taskUpdateTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty taskId", () => {
		const result = taskUpdateTool.inputSchema.safeParse({ taskId: "" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid status enum", () => {
		const result = taskUpdateTool.inputSchema.safeParse({ taskId: "task-123", status: "done" })
		expect(result.success).toBe(false)
	})
})
