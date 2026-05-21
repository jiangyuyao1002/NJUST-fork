import { describe, it, expect } from "vitest"
import { updateTodoListTool } from "../UpdateTodoListTool"

describe("UpdateTodoListTool schema", () => {
	it("passes with valid input", () => {
		const result = updateTodoListTool.inputSchema.safeParse({ todos: "- [ ] task 1\n- [x] task 2" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = updateTodoListTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty todos", () => {
		const result = updateTodoListTool.inputSchema.safeParse({ todos: "" })
		expect(result.success).toBe(false)
	})
})
