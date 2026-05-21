import { describe, it, expect } from "vitest"
import { sendMessageTool } from "../SendMessageTool"

describe("SendMessageTool schema", () => {
	it("passes with valid input", () => {
		const result = sendMessageTool.inputSchema.safeParse({ targetTaskId: "task-123", message: "Hello" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = sendMessageTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty message", () => {
		const result = sendMessageTool.inputSchema.safeParse({ targetTaskId: "task-123", message: "" })
		expect(result.success).toBe(false)
	})
})
