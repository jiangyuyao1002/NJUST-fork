import { describe, it, expect } from "vitest"
import { accessMcpResourceTool } from "../accessMcpResourceTool"

describe("AccessMcpResourceTool schema", () => {
	it("passes with valid input", () => {
		const result = accessMcpResourceTool.inputSchema.safeParse({ server_name: "test-server", uri: "test://resource" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = accessMcpResourceTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty server_name", () => {
		const result = accessMcpResourceTool.inputSchema.safeParse({ server_name: "", uri: "test://resource" })
		expect(result.success).toBe(false)
	})
})
