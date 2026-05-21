import { describe, it, expect } from "vitest"
import { taskListTool } from "../TaskListTool"

describe("TaskListTool schema", () => {
	it("passes with valid input", () => {
		const result = taskListTool.inputSchema.safeParse({})
		expect(result.success).toBe(true)
	})

	it("passes with optional filters", () => {
		const result = taskListTool.inputSchema.safeParse({ status: "pending", priority: "high", limit: 10 })
		expect(result.success).toBe(true)
	})

	it("fails with invalid status enum", () => {
		const result = taskListTool.inputSchema.safeParse({ status: "active" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid priority enum", () => {
		const result = taskListTool.inputSchema.safeParse({ priority: "urgent" })
		expect(result.success).toBe(false)
	})
})
