import { describe, it, expect } from "vitest"
import { worktreeTool } from "../WorktreeTool"

describe("WorktreeTool schema", () => {
	it("passes with valid enter action", () => {
		const result = worktreeTool.inputSchema.safeParse({ action: "enter", branch: "feature-x" })
		expect(result.success).toBe(true)
	})

	it("passes with valid exit action", () => {
		const result = worktreeTool.inputSchema.safeParse({ action: "exit" })
		expect(result.success).toBe(true)
	})

	it("fails when branch/path missing for enter", () => {
		const result = worktreeTool.inputSchema.safeParse({ action: "enter" })
		expect(result.success).toBe(false)
	})

	it("fails with invalid action enum", () => {
		const result = worktreeTool.inputSchema.safeParse({ action: "create" })
		expect(result.success).toBe(false)
	})
})
