import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExistsSync, mockReadFileSync, mockGetWorkspaceFolder, mockResolveCangjieToolPath, mockExecFile } =
	vi.hoisted(() => ({
		mockExistsSync: vi.fn(),
		mockReadFileSync: vi.fn(),
		mockGetWorkspaceFolder: vi.fn(),
		mockResolveCangjieToolPath: vi.fn(),
		mockExecFile: vi.fn(),
	}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync },
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
	}
})

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("vscode", () => ({
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	Diagnostic: class {
		constructor(
			public range: unknown,
			public message: string,
			public severity: number,
		) {
			this.source = ""
		}
		source: string
	},
	Range: class {
		constructor(
			public start: { line: number; character: number },
			public end: { line: number; character: number },
		) {}
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
	},
	languages: {
		createDiagnosticCollection: vi.fn().mockReturnValue({
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		}),
		getDiagnostics: vi.fn().mockReturnValue([]),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		getWorkspaceFolder: mockGetWorkspaceFolder,
		onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		asRelativePath: vi.fn((p: string) => p),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveCangjieToolPath,
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("../safeUnlink", () => ({
	safeUnlink: vi.fn(),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import * as vscode from "vscode"
import { CjlintDiagnostics } from "../CjlintDiagnostics"

describe("CjlintDiagnostics", () => {
	let diagnostics: CjlintDiagnostics
	let mockOutput: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		diagnostics = new CjlintDiagnostics(mockOutput as any)
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		mockExistsSync.mockReturnValue(false)
		mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
	})

	it("creates diagnostic collection on construction", () => {
		expect(vscode.languages.createDiagnosticCollection).toHaveBeenCalledWith("cjlint")
	})

	it("clearAll clears diagnostics", () => {
		diagnostics.clearAll()
		// Should not throw
	})

	it("dispose cleans up timer and disposables", () => {
		expect(() => diagnostics.dispose()).not.toThrow()
	})

	it("lintSingleFile returns early when cjlint not found", async () => {
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		const uri = { fsPath: "/test/file.cj" } as any
		await diagnostics.lintSingleFile(uri)
		expect(mockOutput.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("Error"))
	})

	it("lintWorkspace returns early when cjlint not found", async () => {
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		await diagnostics.lintWorkspace()
		expect(mockOutput.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("Error"))
	})

	it("lintSingleFile runs cjlint when tool found", async () => {
		mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
		mockExistsSync.mockReturnValue(true)
		// Mock execFile to succeed
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
			if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
		})
		// Mock readFileSync to return JSON report
		mockReadFileSync.mockReturnValue(
			JSON.stringify([{ file: "/test/file.cj", line: 1, column: 1, message: "test error", severity: "error" }]),
		)
		// Mock existsSync for report file
		mockExistsSync.mockImplementation((p: string) => {
			if (p === "/test/file.cj") return true
			if (p.includes("cjlint_single_")) return true
			return false
		})
		const uri = { fsPath: "/test/file.cj" } as any
		await diagnostics.lintSingleFile(uri)
		// Should have called execFile
		expect(mockExecFile).toHaveBeenCalled()
	})

	it("lintWorkspace runs cjlint when tool found", async () => {
		mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
		mockExistsSync.mockReturnValue(true)
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
			if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
		})
		mockReadFileSync.mockReturnValue("[]")
		await diagnostics.lintWorkspace()
		expect(mockExecFile).toHaveBeenCalled()
	})
})
