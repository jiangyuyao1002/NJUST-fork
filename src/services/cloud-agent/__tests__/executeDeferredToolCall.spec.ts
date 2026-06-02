import { describe, it, expect, vi } from "vitest"
import { executeDeferredToolCall } from "../executeDeferredToolCall"
import type { DeferredToolCall } from "../types"
import type { RooIgnoreController } from "../../../core/ignore/RooIgnoreController"
import type { RooProtectedController } from "../../../core/protect/RooProtectedController"

vi.mock("../../mcp-server/tool-executors", () => ({
	execReadFile: vi.fn(() => Promise.resolve("file content")),
	execWriteFile: vi.fn(() => Promise.resolve("file written")),
	execListFiles: vi.fn(() => Promise.resolve("file1\nfile2")),
	execSearchFiles: vi.fn(() => Promise.resolve("search results")),
	execCommand: vi.fn(function (_cwd, params, allowedCommands, deniedCommands) {
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

	function createRooIgnoreController(options?: {
		allowPath?: (path: string) => boolean
		validateCommand?: (command: string) => string | undefined
	}): RooIgnoreController {
		return {
			validateAccess: vi.fn(options?.allowPath ?? ((path: string) => !path.includes(".rooignore"))),
			validateCommand: vi.fn(options?.validateCommand ?? (() => undefined)),
		} as unknown as RooIgnoreController
	}

	function createRooProtectedController(isWriteProtected: (path: string) => boolean): RooProtectedController {
		return {
			isWriteProtected: vi.fn(isWriteProtected),
		} as unknown as RooProtectedController
	}

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

	describe("path protection checks", () => {
		it("rejects write_file to .rooignore path", async () => {
			const rooIgnoreController = createRooIgnoreController()
			const call: DeferredToolCall = {
				call_id: "test-5",
				tool: "write_file",
				arguments: { path: ".rooignore/config.json", content: "test" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
		})

		it("rejects apply_diff to .rooignore path", async () => {
			const rooIgnoreController = createRooIgnoreController()
			const call: DeferredToolCall = {
				call_id: "test-6",
				tool: "apply_diff",
				arguments: { path: ".rooignore/config.json", diff: "test" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
		})

		it("allows write_file to normal path", async () => {
			const call: DeferredToolCall = {
				call_id: "test-7",
				tool: "write_file",
				arguments: { path: "src/index.ts", content: "test" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
		})
	})

	describe("read_file .rooignore checks", () => {
		it("rejects read_file to .rooignore path", async () => {
			const rooIgnoreController = createRooIgnoreController()
			const call: DeferredToolCall = {
				call_id: "test-read-1",
				tool: "read_file",
				arguments: { path: ".rooignore/secret.txt" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
		})

		it("allows read_file to .rooignore path when no rooIgnoreController is provided", async () => {
			const call: DeferredToolCall = {
				call_id: "test-read-default",
				tool: "read_file",
				arguments: { path: ".rooignore/secret.txt" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
			expect(result.content).toBe("file content")
		})

		it("allows read_file to normal path", async () => {
			const call: DeferredToolCall = {
				call_id: "test-read-2",
				tool: "read_file",
				arguments: { path: "src/index.ts" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
			expect(result.content).toBe("file content")
		})
	})

	describe("list_files .rooignore checks", () => {
		it("rejects list_files to .rooignore directory", async () => {
			const rooIgnoreController = createRooIgnoreController()
			const call: DeferredToolCall = {
				call_id: "test-list-1",
				tool: "list_files",
				arguments: { path: ".rooignore" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
		})

		it("allows list_files to normal directory", async () => {
			const call: DeferredToolCall = {
				call_id: "test-list-2",
				tool: "list_files",
				arguments: { path: "src" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
		})
	})

	describe("search_files .rooignore checks", () => {
		it("rejects search_files to .rooignore directory", async () => {
			const rooIgnoreController = createRooIgnoreController()
			const call: DeferredToolCall = {
				call_id: "test-search-1",
				tool: "search_files",
				arguments: { path: ".rooignore", regex: "test" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
		})

		it("allows search_files to normal directory", async () => {
			const call: DeferredToolCall = {
				call_id: "test-search-2",
				tool: "search_files",
				arguments: { path: "src", regex: "test" },
			}

			const result = await executeDeferredToolCall(cwd, call)

			expect(result.is_error).toBe(false)
		})
	})

	describe("execute_command .rooignore checks", () => {
		it("rejects command accessing .rooignore path", async () => {
			const rooIgnoreController = createRooIgnoreController({
				allowPath: () => true,
				validateCommand: (cmd: string) => {
					if (cmd.includes(".rooignore")) return ".rooignore/secret.txt"
					return undefined
				},
			})

			const call: DeferredToolCall = {
				call_id: "test-cmd-1",
				tool: "execute_command",
				arguments: { command: "cat .rooignore/secret.txt" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Access denied by .rooignore")
			expect(rooIgnoreController.validateCommand).toHaveBeenCalledWith("cat .rooignore/secret.txt")
		})

		it("allows command not accessing .rooignore path", async () => {
			const rooIgnoreController = createRooIgnoreController({ allowPath: () => true })

			const call: DeferredToolCall = {
				call_id: "test-cmd-2",
				tool: "execute_command",
				arguments: { command: "echo test" },
			}

			const result = await executeDeferredToolCall(cwd, call, undefined, undefined, rooIgnoreController)

			expect(result.is_error).toBe(false)
		})
	})

	describe("write_file protected checks", () => {
		it("rejects write_file to protected path", async () => {
			const rooProtectedController = createRooProtectedController((path) => path.includes(".njust_ai"))

			const call: DeferredToolCall = {
				call_id: "test-protected-1",
				tool: "write_file",
				arguments: { path: ".njust_ai/settings.json", content: "{}" },
			}

			const result = await executeDeferredToolCall(
				cwd,
				call,
				undefined,
				undefined,
				undefined,
				rooProtectedController,
			)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Write protected")
		})
	})

	describe("apply_diff protected checks", () => {
		it("rejects apply_diff to protected path", async () => {
			const rooProtectedController = createRooProtectedController((path) => path.includes(".njust_ai"))

			const call: DeferredToolCall = {
				call_id: "test-protected-2",
				tool: "apply_diff",
				arguments: { path: ".njust_ai/settings.json", diff: "test" },
			}

			const result = await executeDeferredToolCall(
				cwd,
				call,
				undefined,
				undefined,
				undefined,
				rooProtectedController,
			)

			expect(result.is_error).toBe(true)
			expect(result.content).toContain("Write protected")
		})
	})
})
