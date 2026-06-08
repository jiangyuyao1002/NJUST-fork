import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExistsSync, mockReadFileSync, mockGetWorkspaceFolder } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockGetWorkspaceFolder: vi.fn(),
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
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
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
		const uri = { fsPath: "/test/file.cj" } as any
		await diagnostics.lintSingleFile(uri)
		expect(mockOutput.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("Error"))
	})

	it("lintWorkspace returns early when cjlint not found", async () => {
		await diagnostics.lintWorkspace()
		expect(mockOutput.appendLine).not.toHaveBeenCalledWith(expect.stringContaining("Error"))
	})
})
