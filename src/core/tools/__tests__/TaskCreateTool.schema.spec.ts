import { describe, it, expect } from "vitest"
import { taskCreateTool } from "../TaskCreateTool"

describe("TaskCreateTool schema", () => {
	it("passes with valid input", () => {
		const result = taskCreateTool.inputSchema.safeParse({ title: "New task" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = taskCreateTool.inputSchema.safeParse({
			title: "New task",
			description: "Details",
			priority: "high",
			dependsOn: ["task-1"],
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = taskCreateTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty title", () => {
		const result = taskCreateTool.inputSchema.safeParse({ title: "" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid priority enum", () => {
		const result = taskCreateTool.inputSchema.safeParse({ title: "New task", priority: "urgent" })
		expect(result.success).toBe(false)
	})
})
