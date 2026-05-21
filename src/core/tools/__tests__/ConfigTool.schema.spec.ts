import { describe, it, expect } from "vitest"
import { configTool } from "../ConfigTool"

describe("ConfigTool schema", () => {
	it("passes with valid list action", () => {
		const result = configTool.inputSchema.safeParse({ action: "list" })
		expect(result.success).toBe(true)
	})

	it("passes with valid get action", () => {
		const result = configTool.inputSchema.safeParse({ action: "get", key: "apiKey" })
		expect(result.success).toBe(true)
	})

	it("fails when key is missing for get", () => {
		const result = configTool.inputSchema.safeParse({ action: "get" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid action enum", () => {
		const result = configTool.inputSchema.safeParse({ action: "delete" })
		expect(result.success).toBe(false)
	})
})
