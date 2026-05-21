import { describe, it, expect } from "vitest"
import { runSlashCommandTool } from "../RunSlashCommandTool"

describe("RunSlashCommandTool schema", () => {
	it("passes with valid input", () => {
		const result = runSlashCommandTool.inputSchema.safeParse({ command: "/help" })
		expect(result.success).toBe(true)
	})

	it("passes with optional args", () => {
		const result = runSlashCommandTool.inputSchema.safeParse({ command: "/help", args: "--verbose" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = runSlashCommandTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty command", () => {
		const result = runSlashCommandTool.inputSchema.safeParse({ command: "" })
		expect(result.success).toBe(false)
	})
})
