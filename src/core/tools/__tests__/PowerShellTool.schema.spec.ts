import { describe, it, expect } from "vitest"
import { powerShellTool } from "../PowerShellTool"

describe("PowerShellTool schema", () => {
	it("passes with valid input", () => {
		const result = powerShellTool.inputSchema.safeParse({ command: "Get-Process" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = powerShellTool.inputSchema.safeParse({ command: "Get-Process", cwd: "C:\\", timeout: 30 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = powerShellTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty command", () => {
		const result = powerShellTool.inputSchema.safeParse({ command: "" })
		expect(result.success).toBe(false)
	})
})
