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

	describe("Force Bypass delete/commit protection", () => {
		const bypassState = (patch: Record<string, unknown> = {}) =>
			baseState({ alwaysAllowAll: true, mode: "code", ...patch })

		it("blocks 'rm' command even with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "rm somefile.txt",
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'rmdir' command even with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "rmdir /s /q mydir",
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'Remove-Item' command even with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "Remove-Item -Path C:\\temp",
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'del' command even with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "del myfile.txt",
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'git commit' even with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "git commit -m 'update'",
			})
			expect(result.decision).toBe("ask")
		})

		it("approves safe commands with bypass active", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "echo hello world",
			})
			expect(result.decision).toBe("approve")
		})

		it("falls through to normal checks when bypass is off", async () => {
			const result = await checkAutoApproval({
				state: baseState({ alwaysAllowAll: false, mode: "code" }),
				ask: "command",
				text: "rm -rf /",
			})
			// classifyBashCommand("rm -rf /") → dangerous → deny
			expect(result.decision).toBe("deny")
		})

		it("blocks 'del' with quoted path (no trailing space)", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: 'del"C:\\path\\to\\file"',
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'rd /s /q' (Windows rmdir equivalent)", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: "rd /s /q mydir",
			})
			expect(result.decision).toBe("ask")
		})

		it("blocks 'rm' embedded in echo string (safety-biased false positive)", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "command",
				text: 'echo "rm important.txt"',
			})
			expect(result.decision).toBe("ask")
		})

		it("bypass still approves ask === 'tool' (patterns scoped to command only)", async () => {
			const result = await checkAutoApproval({
				state: bypassState(),
				ask: "tool",
				text: "rm somefile",
			})
			// Force Bypass applies to all ask types; the new command patterns
			// are gated on `ask === "command"` and must not leak into the tool branch.
			expect(result.decision).toBe("approve")
		})
	})
})
