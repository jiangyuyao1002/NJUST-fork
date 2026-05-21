import { describe, it, expect } from "vitest"
import { executeCommandTool } from "../ExecuteCommandTool"

describe("ExecuteCommandTool schema", () => {
	it("passes with valid input", () => {
		const result = executeCommandTool.inputSchema.safeParse({ command: "ls -la" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = executeCommandTool.inputSchema.safeParse({ command: "ls", cwd: "/tmp", timeout: 30 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = executeCommandTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty command", () => {
		const result = executeCommandTool.inputSchema.safeParse({ command: "" })
		expect(result.success).toBe(false)
	})
})
