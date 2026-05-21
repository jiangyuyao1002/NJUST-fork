import { describe, it, expect } from "vitest"
import { readCommandOutputTool } from "../ReadCommandOutputTool"

describe("ReadCommandOutputTool schema", () => {
	it("passes with valid input", () => {
		const result = readCommandOutputTool.inputSchema.safeParse({ artifact_id: "cmd-123.txt" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = readCommandOutputTool.inputSchema.safeParse({ artifact_id: "cmd-123.txt", search: "error", offset: 0, limit: 1024 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = readCommandOutputTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty artifact_id", () => {
		const result = readCommandOutputTool.inputSchema.safeParse({ artifact_id: "" })
		expect(result.success).toBe(false)
	})
})
