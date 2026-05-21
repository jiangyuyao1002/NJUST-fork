import { describe, it, expect, vi } from "vitest"
import { executeDeferredToolCall } from "../executeDeferredToolCall"
import type { DeferredToolCall } from "../types"

vi.mock("../../mcp-server/tool-executors", () => ({
	execReadFile: vi.fn(() => Promise.resolve("file content")),
	execWriteFile: vi.fn(() => Promise.resolve("file written")),
	execListFiles: vi.fn(() => Promise.resolve("file1\nfile2")),
	execSearchFiles: vi.fn(() => Promise.resolve("search results")),
	execCommand: vi.fn((_cwd, params, allowedCommands, deniedCommands) => {
		if (allowedCommands?.length) {
			const baseName = params.command.split(/\s+/)[0]
			const hasWildcard = allowedCommands.some((c: string) => c.trim().toLowerCase() === "*")
			if (!hasWildcard && !allowedCommands.some((c: string) => params.command.startsWith(c))) {
				return Promise.reject(new Error(`Command not in allowed list: ${baseName}`))
			}
		}
		if (deniedCommands?.length) {
			const baseName = params.command.split(/\s+/)[0]
			if (deniedCommands.some((c: string) => params.command.startsWith(c))) {
				return Promise.reject(new Error(`Command denied by policy: ${baseName}`))
			}
		}
		return Promise.resolve("command executed")
	}),
	execApplyDiff: vi.fn(() => Promise.resolve("diff applied")),
}))

describe("executeDeferredToolCall security", () => {
	const cwd = "/test/workspace"

	describe("execute_command passes allowedCommands/deniedCommands", () => {
		it("passes allowedCommands to execCommand", async () => {
			const call: DeferredToolCall = {
				call_id: "test-1",
				tool: "execute_command",
				arguments: { command: "echo test" },
			}

			const result = await executeDeferredToolCall(cwd, call, ["echo", "git"], [])

			expect(result.is_error).toBe(false)
			expect(result.content).toBe("command executed")
		})

		it("passes deniedCommands to execCommand", async () => {
			const call: DeferredToolCall = {
				call_id: "test-2",
				tool: "execute_command",
				arguments: { command: "rm file" },
			}

			const result = await executeDeferredToolCall(cwd, call, ["*"], ["rm"])

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Command denied by policy")
		})

		it("rejects command not in allowed list", async () => {
			const call: DeferredToolCall = {
				call_id: "test-3",
				tool: "execute_command",
				arguments: { command: "npm install" },
			}

			const result = await executeDeferredToolCall(cwd, call, ["git", "echo"], [])

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Command not in allowed list")
		})

		it("works without allowedCommands/deniedCommands", async () => {
			const call: DeferredToolCall = {
				call_id: "test-4",
				tool: "execute_command",
				arguments: { command: "echo test" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
		})
	})
})
