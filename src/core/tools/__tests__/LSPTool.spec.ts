import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { isPathOutsideWorkspaceMock, formatResponseMock } = vi.hoisted(() => ({
	isPathOutsideWorkspaceMock: vi.fn(),
	formatResponseMock: vi.fn((msg: string) => `ERROR: ${msg}`),
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: isPathOutsideWorkspaceMock,
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: formatResponseMock,
	},
}))

vi.mock("../../../shared/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("../../security/metrics", () => ({
	recordSecurityMetric: vi.fn(),
	startTraceSpan: vi.fn(() => ({ end: vi.fn() })),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

// Mock the vscode module that getVscodeModule() dynamically imports
const { mockVscodeExecuteCommand, mockVscodeOpenTextDocument } = vi.hoisted(() => ({
	mockVscodeExecuteCommand: vi.fn(),
	mockVscodeOpenTextDocument: vi.fn(),
}))

vi.mock("vscode", () => ({
	Uri: {
		file: (p: string) => ({ fsPath: p, path: p, scheme: "file", toString: () => p }),
	},
	Position: class {
		line: number
		character: number
		constructor(line: number, character: number) {
			this.line = line
			this.character = character
		}
	},
	commands: {
		executeCommand: mockVscodeExecuteCommand,
	},
	workspace: {
		openTextDocument: mockVscodeOpenTextDocument,
	},
}))

import { LSPTool } from "../LSPTool"

// ── Helpers ─────────────────────────────────────────────────────────────

function makeCallbacks(overrides?: Partial<any>) {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		...overrides,
	}
}

function makeTask(overrides?: any) {
	return {
		taskId: "test-task",
		cwd: "/workspace",
		taskMode: "default",
		...overrides,
	}
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("LSPTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		isPathOutsideWorkspaceMock.mockReturnValue(false)
		mockVscodeOpenTextDocument.mockResolvedValue({
			uri: { fsPath: "/workspace/test.ts" },
		})
	})

	describe("tool properties", () => {
		it("has correct name", () => {
			const tool = new LSPTool()
			expect(tool.name).toBe("lsp")
		})

		it("is concurrency safe", () => {
			const tool = new LSPTool()
			expect(tool.isConcurrencySafe()).toBe(true)
		})

		it("is read-only", () => {
			const tool = new LSPTool()
			expect(tool.isReadOnly()).toBe(true)
		})

		it("returns 'LSP' as user-facing name", () => {
			const tool = new LSPTool()
			expect(tool.userFacingName()).toBe("LSP")
		})

		it("shouldDefer is true", () => {
			const tool = new LSPTool()
			expect(tool.shouldDefer).toBe(true)
		})

		it("has search hints", () => {
			const tool = new LSPTool()
			expect(tool.searchHint).toContain("lsp")
			expect(tool.searchHint).toContain("definition")
			expect(tool.searchHint).toContain("references")
		})
	})

	describe("validateInput", () => {
		it("requires symbolName for symbols action", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "symbols",
				filePath: "test.ts",
			})
			expect(result.valid).toBe(false)
			expect(result.error).toContain("symbolName is required")
		})

		it("allows symbols action with symbolName", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "symbols",
				filePath: "test.ts",
				symbolName: "MyClass",
			})
			expect(result.valid).toBe(true)
		})

		it("rejects empty symbolName for symbols action", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "symbols",
				filePath: "test.ts",
				symbolName: "   ",
			})
			expect(result.valid).toBe(false)
		})

		it("requires line and character for definition action", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "definition",
				filePath: "test.ts",
			})
			expect(result.valid).toBe(false)
			expect(result.error).toContain("line and character are required")
		})

		it("requires line and character for references action", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "references",
				filePath: "test.ts",
			})
			expect(result.valid).toBe(false)
		})

		it("requires line and character for hover action", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "hover",
				filePath: "test.ts",
			})
			expect(result.valid).toBe(false)
		})

		it("allows definition action with line and character", () => {
			const tool = new LSPTool()
			const result = tool.validateInput({
				action: "definition",
				filePath: "test.ts",
				line: 10,
				character: 5,
			})
			expect(result.valid).toBe(true)
		})
	})

	describe("execute() - definition action", () => {
		it("returns location results for definition query", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					uri: { fsPath: "/workspace/src/defs.ts", toString: () => "/workspace/src/defs.ts" },
					range: { start: { line: 4, character: 0 }, end: { line: 4, character: 20 } },
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "src/main.ts", line: 10, character: 5 },
				task as any,
				callbacks,
			)

			expect(mockVscodeOpenTextDocument).toHaveBeenCalled()
			expect(mockVscodeExecuteCommand).toHaveBeenCalledWith(
				"vscode.executeDefinitionProvider",
				expect.any(Object),
				expect.objectContaining({ line: 9, character: 4 }), // 1-based to 0-based
			)
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("defs.ts:5:1"))
		})
	})

	describe("execute() - references action", () => {
		it("returns location results for references query", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					uri: { fsPath: "/workspace/a.ts", toString: () => "/workspace/a.ts" },
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
				},
				{
					uri: { fsPath: "/workspace/b.ts", toString: () => "/workspace/b.ts" },
					range: { start: { line: 5, character: 2 }, end: { line: 5, character: 15 } },
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "references", filePath: "src/main.ts", line: 3, character: 1 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("a.ts:1:1"))
		})
	})

	describe("execute() - hover action", () => {
		it("returns hover information", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					contents: [{ value: "```typescript\nconst x: number\n```" }],
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute({ action: "hover", filePath: "test.ts", line: 1, character: 1 }, task as any, callbacks)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("const x: number"))
		})

		it("returns no hover info message when empty", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute({ action: "hover", filePath: "test.ts", line: 1, character: 1 }, task as any, callbacks)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No hover information available"))
		})

		it("handles string content in hover results", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([{ contents: ["plain string info"] }])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute({ action: "hover", filePath: "test.ts", line: 1, character: 1 }, task as any, callbacks)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("plain string info"))
		})
	})

	describe("execute() - symbols action", () => {
		it("returns workspace symbol results", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					kind: 4, // Class
					name: "MyClass",
					location: {
						uri: { fsPath: "/workspace/src/myclass.ts", toString: () => "/workspace/src/myclass.ts" },
						range: { start: { line: 9, character: 0 }, end: { line: 9, character: 20 } },
					},
				},
				{
					kind: 11, // Function
					name: "helperFn",
					location: {
						uri: { fsPath: "/workspace/src/helpers.ts", toString: () => "/workspace/src/helpers.ts" },
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 15 } },
					},
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "symbols", filePath: "test.ts", symbolName: "MyClass" },
				task as any,
				callbacks,
			)

			expect(mockVscodeExecuteCommand).toHaveBeenCalledWith("vscode.executeWorkspaceSymbolProvider", "MyClass")
			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("[Class] MyClass"))
		})

		it("returns no symbols message when empty", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "symbols", filePath: "test.ts", symbolName: "NonExistent" },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith("No symbols found.")
		})

		it("handles symbols without location", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{ kind: 12, name: "myVar" }, // Variable without location
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute({ action: "symbols", filePath: "test.ts", symbolName: "myVar" }, task as any, callbacks)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("[Variable] myVar"))
		})
	})

	describe("execute() - implementations action", () => {
		it("returns location results for implementations query", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					targetUri: { fsPath: "/workspace/impl.ts", toString: () => "/workspace/impl.ts" },
					targetRange: { start: { line: 2, character: 0 }, end: { line: 10, character: 0 } },
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "implementations", filePath: "iface.ts", line: 5, character: 3 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("impl.ts"))
		})
	})

	describe("execute() - LocationLink format", () => {
		it("handles LocationLink results (targetUri/targetRange)", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([
				{
					targetUri: { fsPath: "/workspace/linked.ts", toString: () => "/workspace/linked.ts" },
					targetRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
				},
			])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("linked.ts:2:1"))
		})
	})

	describe("execute() - no results", () => {
		it("returns 'No results found' when definition returns empty", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith("No results found.")
		})

		it("returns 'No results found' when results have no valid uri/range", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockResolvedValue([{ something: "invalid" }])
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith("No results found.")
		})
	})

	describe("execute() - path outside workspace", () => {
		it("blocks operations on paths outside workspace", async () => {
			const tool = new LSPTool()
			isPathOutsideWorkspaceMock.mockReturnValue(true)
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "/outside/test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Safety"))
			expect(mockVscodeExecuteCommand).not.toHaveBeenCalled()
		})
	})

	describe("execute() - approval denied", () => {
		it("does not execute LSP query when approval is denied", async () => {
			const tool = new LSPTool()
			const askApproval = vi.fn().mockResolvedValue(false)
			const pushToolResult = vi.fn()
			const callbacks = makeCallbacks({ askApproval, pushToolResult })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(mockVscodeExecuteCommand).not.toHaveBeenCalled()
			expect(pushToolResult).not.toHaveBeenCalled()
		})
	})

	describe("execute() - error handling", () => {
		it("calls handleError when LSP query throws", async () => {
			const tool = new LSPTool()
			mockVscodeExecuteCommand.mockRejectedValue(new Error("LSP server crashed"))
			const handleError = vi.fn()
			const callbacks = makeCallbacks({ handleError })
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(handleError).toHaveBeenCalledWith("LSP query", expect.any(Error))
		})
	})

	describe("execute() - resets partial state", () => {
		it("calls resetPartialState in finally block", async () => {
			const tool = new LSPTool()
			const resetSpy = vi.spyOn(tool, "resetPartialState")
			mockVscodeExecuteCommand.mockResolvedValue([])
			const callbacks = makeCallbacks()
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(resetSpy).toHaveBeenCalled()
		})

		it("calls resetPartialState even on error", async () => {
			const tool = new LSPTool()
			const resetSpy = vi.spyOn(tool, "resetPartialState")
			mockVscodeExecuteCommand.mockRejectedValue(new Error("fail"))
			const callbacks = makeCallbacks()
			const task = makeTask()

			await tool.execute(
				{ action: "definition", filePath: "test.ts", line: 1, character: 1 },
				task as any,
				callbacks,
			)

			expect(resetSpy).toHaveBeenCalled()
		})
	})
})
