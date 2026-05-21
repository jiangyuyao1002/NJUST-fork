import { describe, it, expect } from "vitest"
import { agentTool } from "../AgentTool"

describe("AgentTool schema", () => {
	it("passes with valid input", () => {
		const result = agentTool.inputSchema.safeParse({ task: "Explore the codebase" })
		expect(result.success).toBe(true)
	})

	it("passes with optional fields", () => {
		const result = agentTool.inputSchema.safeParse({ task: "Explore", agentType: "explore", maxTurns: 10 })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = agentTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with invalid agentType enum", () => {
		const result = agentTool.inputSchema.safeParse({ task: "Explore", agentType: "invalid" })
		expect(result.success).toBe(false)
	})
})
