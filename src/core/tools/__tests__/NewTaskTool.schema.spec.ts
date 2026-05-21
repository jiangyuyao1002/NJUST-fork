import { describe, it, expect } from "vitest"
import { newTaskTool } from "../NewTaskTool"

describe("NewTaskTool schema", () => {
	it("passes with valid input", () => {
		const result = newTaskTool.inputSchema.safeParse({ mode: "code", message: "Do something" })
		expect(result.success).toBe(true)
	})

	it("passes with optional todos", () => {
		const result = newTaskTool.inputSchema.safeParse({ mode: "code", message: "Do something", todos: "- [ ] task 1" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = newTaskTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty mode", () => {
		const result = newTaskTool.inputSchema.safeParse({ mode: "", message: "Do something" })
		expect(result.success).toBe(false)
	})
})
