import { describe, expect, it } from "vitest"

import { checkAutoApproval } from "../index.js"

const baseState = (patch: Record<string, unknown> = {}) => ({
	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowWrite: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
	...patch,
})

describe("checkAutoApproval - main entry", () => {
	describe("state validation", () => {
		it("returns ask when autoApprovalEnabled is false", async () => {
			const result = await checkAutoApproval({
				state: baseState({ autoApprovalEnabled: false }),
				ask: "tool",
				text: JSON.stringify({ tool: "readFile" }),
			})
			expect(result.decision).toBe("ask")
		})

		it("returns ask when state is undefined", async () => {
			const result = await checkAutoApproval({
				state: undefined,
				ask: "tool",
				text: JSON.stringify({ tool: "readFile" }),
			})
			expect(result.decision).toBe("ask")
		})
	})

	describe("tool branch", () => {
		it("approves read-only tools when alwaysAllowReadOnly is true", async () => {
			const result = await checkAutoApproval({
				state: baseState(),
				ask: "tool",
				text: JSON.stringify({ tool: "readFile" }),
			})
			expect(result.decision).toBe("approve")
		})

		it("asks for write tools when alwaysAllowWrite is false", async () => {
			const result = await checkAutoApproval({
				state: baseState(),
				ask: "tool",
				text: JSON.stringify({ tool: "newFileCreated" }),
			})
			expect(result.decision).toBe("ask")
		})

		it("approves write tools when alwaysAllowWrite is true", async () => {
			const result = await checkAutoApproval({
				state: baseState({ alwaysAllowWrite: true }),
				ask: "tool",
				text: JSON.stringify({ tool: "newFileCreated" }),
			})
			expect(result.decision).toBe("approve")
		})
	})

	describe("command branch", () => {
		it("asks for commands when alwaysAllowExecute is false", async () => {
			const result = await checkAutoApproval({
				state: baseState(),
				ask: "command",
				text: "echo hello",
			})
			expect(result.decision).toBe("ask")
		})
	})

	describe("followup branch", () => {
		it("asks for followup when alwaysAllowFollowupQuestions is false", async () => {
			const result = await checkAutoApproval({
				state: baseState(),
				ask: "followup",
				text: "test",
			})
			expect(result.decision).toBe("ask")
		})
	})

	describe("use_mcp_server branch", () => {
		it("asks for MCP when alwaysAllowMcp is false", async () => {
			const result = await checkAutoApproval({
				state: baseState(),
				ask: "use_mcp_server",
				text: JSON.stringify({ serverName: "test", toolName: "test" }),
			})
			expect(result.decision).toBe("ask")
		})
	})
})
