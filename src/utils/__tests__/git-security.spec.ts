import { describe, it, expect, beforeEach, vi } from "vitest"

// Mock child_process — exec used by checkGitInstalled/checkGitRepo, execFile used by searchCommits (after fix)
vi.mock("child_process", () => ({
	exec: vi.fn(),
	execFile: vi.fn(),
}))

// Mock vscode
vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return undefined
		},
	},
}))

type ExecFunction = (
	command: string,
	options: { cwd?: string },
	callback: (error: any, result?: { stdout: string; stderr: string }) => void,
) => void

type PromisifiedExec = (command: string, options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>

// Mock util.promisify to bridge mocks
vi.mock("util", () => ({
	promisify: vi.fn((fn: ExecFunction): PromisifiedExec => {
		return async (command: string, options?: { cwd?: string }) => {
			return new Promise((resolve, reject) => {
				fn(command, options || {}, (error, result) => {
					if (error) reject(error)
					else resolve(result!)
				})
			})
		}
	}),
}))

vi.mock("../../integrations/misc/extract-text", () => ({
	truncateOutput: vi.fn((text) => text),
}))

import { exec, execFile } from "child_process"
import { searchCommits } from "../git"

const mockExec = vi.mocked(exec)
const mockExecFile = vi.mocked(execFile)

// Helper: set up exec mock for checkGitInstalled + checkGitRepo
function setupExecMocks() {
	mockExec.mockImplementation((command: string, options: any, callback: any) => {
		if (command === "git --version") {
			callback(null, { stdout: "git version 2.39.2", stderr: "" })
			return {} as any
		}
		if (command === "git rev-parse --git-dir") {
			callback(null, { stdout: ".git", stderr: "" })
			return {} as any
		}
		callback(new Error(`Unexpected exec command: ${command}`))
		return {} as any
	})
}

describe("searchCommits security", () => {
	const cwd = "/test/path"

	beforeEach(() => {
		vi.clearAllMocks()
		setupExecMocks()
		// execFile mock with default success for git log
		mockExecFile.mockImplementation((...args: any[]) => {
			const callback = args[args.length - 1]
			const cmd = args[0]
			if (cmd === "git") {
				const cmdArgs = args[1] as string[]
				if (cmdArgs && cmdArgs[0] === "log") {
					callback(null, { stdout: "abc123def456\nabc123\nfix: test\nJohn\n2024-01-06", stderr: "" })
					return {} as any
				}
			}
			callback(new Error("Unexpected execFile command"))
			return {} as any
		})
	})

	it("passes query as separate argument to execFile, not shell interpolation", async () => {
		await searchCommits("test query", cwd)

		const calls = mockExecFile.mock.calls.filter(
			(call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "log",
		)
		expect(calls.length).toBeGreaterThanOrEqual(1)

		const args = calls[0][1] as string[]
		expect(args).toContain("--grep")
		const grepIndex = args.indexOf("--grep")
		expect(args[grepIndex + 1]).toBe("test query")
	})

	it("handles semicolon injection in query safely", async () => {
		await searchCommits("; rm -rf /", cwd)

		const calls = mockExecFile.mock.calls.filter(
			(call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "log",
		)
		expect(calls.length).toBeGreaterThanOrEqual(1)

		const args = calls[0][1] as string[]
		const grepIndex = args.indexOf("--grep")
		expect(args[grepIndex + 1]).toBe("; rm -rf /")
	})

	it("handles command substitution syntax in query safely", async () => {
		await searchCommits("$(whoami)", cwd)

		const calls = mockExecFile.mock.calls.filter(
			(call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "log",
		)
		expect(calls.length).toBeGreaterThanOrEqual(1)

		const args = calls[0][1] as string[]
		const grepIndex = args.indexOf("--grep")
		expect(args[grepIndex + 1]).toBe("$(whoami)")
	})

	it("passes hash fallback as separate argument to execFile", async () => {
		let logCallCount = 0
		mockExecFile.mockImplementation((...args: any[]) => {
			const callback = args[args.length - 1]
			const cmd = args[0]
			if (cmd === "git") {
				const cmdArgs = args[1] as string[]
				if (cmdArgs && cmdArgs[0] === "log") {
					logCallCount++
					if (logCallCount === 1) {
						callback(null, { stdout: "", stderr: "" })
						return {} as any
					}
					callback(null, { stdout: "abc123def456\nabc123\nfeat: hash\nJane\n2024-01-05", stderr: "" })
					return {} as any
				}
			}
			callback(new Error("Unexpected execFile command"))
			return {} as any
		})

		await searchCommits("abc123", cwd)

		const logCalls = mockExecFile.mock.calls.filter(
			(call) => call[0] === "git" && Array.isArray(call[1]) && call[1][0] === "log",
		)
		expect(logCalls.length).toBe(2)

		const hashCallArgs = logCalls[1][1] as string[]
		expect(hashCallArgs).toContain("--author-date-order")
		expect(hashCallArgs[hashCallArgs.length - 1]).toBe("abc123")
	})
})
