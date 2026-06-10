import { describe, it, expect } from "vitest"
import { useMcpToolTool } from "../UseMcpToolTool"

describe("UseMcpToolTool schema", () => {
	it("passes with valid input", () => {
		const result = useMcpToolTool.inputSchema.safeParse({ server_name: "test-server", tool_name: "test-tool" })
		expect(result.success).toBe(true)
	})

	it("passes with optional arguments", () => {
		const result = useMcpToolTool.inputSchema.safeParse({
			server_name: "test-server",
			tool_name: "test-tool",
			arguments: { key: "value" },
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = useMcpToolTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty server_name", () => {
		const result = useMcpToolTool.inputSchema.safeParse({ server_name: "", tool_name: "test-tool" })
		expect(result.success).toBe(false)
	})
})
