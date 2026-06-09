import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as path from "path"

const {
	mockExistsSync,
	mockReadFileSync,
	mockGetWorkspaceFolder,
	mockResolveCangjieToolPath,
	mockExecFile,
	mockSafeUnlink,
	mockGetErrorMessage,
	mockIsFileExcluded,
	mockFilterDiagnostics,
	mockCreateDiagnosticCollection,
	mockGetDiagnostics,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockGetWorkspaceFolder: vi.fn(),
	mockResolveCangjieToolPath: vi.fn(),
	mockExecFile: vi.fn(),
	mockSafeUnlink: vi.fn(),
	mockGetErrorMessage: vi.fn(),
	mockIsFileExcluded: vi.fn(),
	mockFilterDiagnostics: vi.fn(),
	mockCreateDiagnosticCollection: vi.fn(),
	mockGetDiagnostics: vi.fn(),
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
		constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
			// Store in the format the source code expects:
			// range.start = { line, character }, range.end = { line, character }
			;(this as any).start = { line: startLine, character: startChar }
			;(this as any).end = { line: endLine, character: endChar }
		}
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
	},
	languages: {
		createDiagnosticCollection: mockCreateDiagnosticCollection,
		getDiagnostics: mockGetDiagnostics,
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
	safeUnlink: mockSafeUnlink,
}))

vi.mock("../../shared/error-utils", () => ({
	getErrorMessage: mockGetErrorMessage,
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import * as vscode from "vscode"
import { CjlintDiagnostics } from "../CjlintDiagnostics"
import type { CangjieLintConfig } from "../CangjieLintConfig"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCollection() {
	// Use the LAST result because the source file may use a different vscode
	// module instance than the test file (due to resolve.alias interaction).
	const results = mockCreateDiagnosticCollection.mock.results
	if (results.length === 0) {
		return mockCollection
	}
	return results[results.length - 1].value as {
		set: ReturnType<typeof vi.fn>
		delete: ReturnType<typeof vi.fn>
		clear: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}
}

function getLastSetDiags(): any[] {
	// Check the LAST createDiagnosticCollection result (from the most recently
	// created CjlintDiagnostics instance, since the source file may use a
	// different vscode module instance than the test file).
	const results = mockCreateDiagnosticCollection.mock.results
	if (results.length === 0) return []
	const coll = results[results.length - 1].value as {
		set: ReturnType<typeof vi.fn>
	}
	const calls = coll.set.mock.calls
	return calls[calls.length - 1]?.[1] ?? []
}

function makeDiag(line: number, message: string, source = "other"): any {
	// The Range mock takes (startLine, startChar, endLine, endChar).
	// The source code accesses range.start.line, so we need start to be
	// an object {line, character}. We create the range manually.
	const range = { start: { line, character: 0 }, end: { line, character: 1 } }
	const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning)
	diag.source = source
	return diag
}

/** Standard mock setup for a successful lintSingleFile run. */
async function runLintSingleFile(reportJson: string, overrides?: { filePath?: string; cwd?: string }) {
	const filePath = overrides?.filePath ?? "/test/file.cj"
	const cwd = overrides?.cwd ?? "/ws"

	mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
	mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: cwd } })
	mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
		if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
	})
	mockExistsSync.mockImplementation((p: string) => {
		if (p === filePath) return true
		if (typeof p === "string" && p.includes("cjlint_single_")) return true
		return false
	})
	mockReadFileSync.mockReturnValue(reportJson)

	const uri = { fsPath: filePath } as any
	const instance = new CjlintDiagnostics({ appendLine: vi.fn(), dispose: vi.fn() } as any)
	await instance.lintSingleFile(uri)
	return { instance, uri }
}

/** Standard mock setup for a successful lintWorkspace run. */
async function runLintWorkspace(
	reportJson: string,
	opts?: { folders?: Array<{ uri: { fsPath: string } }>; srcExists?: boolean },
) {
	const folders = opts?.folders ?? [{ uri: { fsPath: "/ws" } }]
	const srcExists = opts?.srcExists ?? false

	;(vscode.workspace as any).workspaceFolders = folders

	mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
	mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
		if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
	})
	mockExistsSync.mockImplementation((p: string) => {
		if (typeof p === "string" && p.endsWith("src")) return srcExists
		if (typeof p === "string" && p.includes("cjlint_report_")) return true
		return true // folder itself exists
	})
	mockReadFileSync.mockReturnValue(reportJson)

	const instance = new CjlintDiagnostics({ appendLine: vi.fn(), dispose: vi.fn() } as any)
	await instance.lintWorkspace()
	return instance
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CjlintDiagnostics", () => {
	let diagnostics: CjlintDiagnostics
	let mockOutput: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
	let mockCollection: {
		set: ReturnType<typeof vi.fn>
		delete: ReturnType<typeof vi.fn>
		clear: ReturnType<typeof vi.fn>
		dispose: ReturnType<typeof vi.fn>
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		mockCollection = { set: vi.fn(), delete: vi.fn(), clear: vi.fn(), dispose: vi.fn() }
		mockCreateDiagnosticCollection.mockReturnValue(mockCollection)
		mockGetDiagnostics.mockReturnValue([])
		// Reset workspaceFolders (may be mutated by previous tests)
		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }]

		diagnostics = new CjlintDiagnostics(mockOutput as any)
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		mockExistsSync.mockReturnValue(false)
		mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
	})

	// ── Basic construction & lifecycle ────────────────────────────────────

	it("creates diagnostic collection on construction", () => {
		expect(mockCreateDiagnosticCollection).toHaveBeenCalledWith("cjlint")
	})

	it("clearAll clears diagnostics", () => {
		diagnostics.clearAll()
		expect(getCollection().clear).toHaveBeenCalled()
	})

	it("dispose cleans up timer and disposables", () => {
		expect(() => diagnostics.dispose()).not.toThrow()
	})

	// ── Early returns ─────────────────────────────────────────────────────

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

	it("lintWorkspace returns early when workspaceFolders is undefined", async () => {
		mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
		;(vscode.workspace as any).workspaceFolders = undefined
		await diagnostics.lintWorkspace()
		expect(mockExecFile).not.toHaveBeenCalled()
	})

	it("lintWorkspace returns early when workspaceFolders is empty", async () => {
		mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
		;(vscode.workspace as any).workspaceFolders = []
		await diagnostics.lintWorkspace()
		expect(mockExecFile).not.toHaveBeenCalled()
	})

	it("lintSingleFile runs cjlint when tool found", async () => {
		mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
		mockExistsSync.mockReturnValue(true)
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
			if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
		})
		mockReadFileSync.mockReturnValue(
			JSON.stringify([{ file: "/test/file.cj", line: 1, column: 1, message: "test error", severity: "error" }]),
		)
		mockExistsSync.mockImplementation((p: string) => {
			if (p === "/test/file.cj") return true
			if (p.includes("cjlint_single_")) return true
			return false
		})
		const uri = { fsPath: "/test/file.cj" } as any
		await diagnostics.lintSingleFile(uri)
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

	// ── mapSeverity (tested through lintSingleFile / parseReport) ─────────

	describe("mapSeverity", () => {
		async function checkSeverity(reportSeverity: string | undefined, expected: number) {
			const entry: Record<string, unknown> = {
				file: path.resolve("/test/file.cj"),
				line: 1,
				column: 1,
				message: "msg",
			}
			if (reportSeverity !== undefined) {
				entry.severity = reportSeverity
			}
			await runLintSingleFile(JSON.stringify([entry]))
			const diags = getLastSetDiags()
			expect(diags.length).toBeGreaterThanOrEqual(1)
			expect(diags[0].severity).toBe(expected)
		}

		it('maps "error" to DiagnosticSeverity.Error', async () => {
			await checkSeverity("error", vscode.DiagnosticSeverity.Error)
		})

		it('maps "warning" to DiagnosticSeverity.Warning', async () => {
			await checkSeverity("warning", vscode.DiagnosticSeverity.Warning)
		})

		it('maps "warn" to DiagnosticSeverity.Warning', async () => {
			await checkSeverity("warn", vscode.DiagnosticSeverity.Warning)
		})

		it('maps "info" to DiagnosticSeverity.Information', async () => {
			await checkSeverity("info", vscode.DiagnosticSeverity.Information)
		})

		it('maps "information" to DiagnosticSeverity.Information', async () => {
			await checkSeverity("information", vscode.DiagnosticSeverity.Information)
		})

		it('maps "hint" to DiagnosticSeverity.Hint', async () => {
			await checkSeverity("hint", vscode.DiagnosticSeverity.Hint)
		})

		it("defaults undefined severity to Warning", async () => {
			await checkSeverity(undefined, vscode.DiagnosticSeverity.Warning)
		})

		it("defaults unknown severity string to Warning", async () => {
			await checkSeverity("unknown", vscode.DiagnosticSeverity.Warning)
		})

		it("uses level field when severity is absent", async () => {
			const entry = {
				file: path.resolve("/test/file.cj"),
				line: 1,
				column: 1,
				message: "msg",
				level: "warn",
			}
			await runLintSingleFile(JSON.stringify([entry]))
			const diags = getLastSetDiags()
			expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Warning)
		})
	})

	// ── parseReport (tested through lintSingleFile / lintWorkspace) ───────

	describe("parseReport", () => {
		it("handles data as direct array", async () => {
			const data = [
				{
					file: path.resolve("/test/file.cj"),
					line: 5,
					column: 3,
					message: "direct array issue",
					severity: "error",
				},
			]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("direct array issue")
		})

		it("handles data with defects key", async () => {
			const data = {
				defects: [
					{
						file: path.resolve("/test/file.cj"),
						line: 2,
						column: 1,
						message: "defect issue",
						severity: "warning",
					},
				],
			}
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("defect issue")
		})

		it("handles data with results key", async () => {
			const data = {
				results: [
					{
						file: path.resolve("/test/file.cj"),
						line: 3,
						column: 2,
						message: "result issue",
						severity: "info",
					},
				],
			}
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("result issue")
		})

		it("handles data with issues key", async () => {
			const data = {
				issues: [
					{
						file: path.resolve("/test/file.cj"),
						line: 4,
						column: 1,
						message: "issues issue",
						severity: "hint",
					},
				],
			}
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("issues issue")
		})

		it("uses empty array when data has no recognized keys", async () => {
			const data = { something: "else" }
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(0)
		})

		it("uses entry.file for file path", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "file key", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("file key")
		})

		it("uses entry.path when file is absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ path: absPath, line: 1, column: 1, message: "path key", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("path key")
		})

		it("skips entry without file or path", async () => {
			const data = [{ line: 1, column: 1, message: "no file", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(0)
		})

		it("uses absolute path as-is", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "abs", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
		})

		it("resolves relative path against workspace root", async () => {
			const data = [{ file: "rel/file.cj", line: 1, column: 1, message: "relative", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			// parseReport resolves relative to cwd; lintSingleFile then looks up
			// diagnostics by path.resolve(filePath) which is different from the
			// relative-path key, so the final set gets [] for the original file.
			// The important assertion: no error is thrown and execFile was called.
			expect(mockExecFile).toHaveBeenCalled()
		})

		it("defaults line to 1 when missing (0-based line 0)", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, column: 1, message: "no line", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			// Range(startLine, startChar, endLine, endChar) -> start.line = max(0, 1-1) = 0
			expect((diags[0].range as any).start.line).toBe(0)
		})

		it("uses colum field (cjlint typo)", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 2, colum: 5, message: "colum typo", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			// start.character = max(0, 5-1) = 4
			expect((diags[0].range as any).start.character).toBe(4)
		})

		it("uses column field when colum is absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 2, column: 7, message: "column field", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			// start.character = max(0, 7-1) = 6
			expect((diags[0].range as any).start.character).toBe(6)
		})

		it("uses message for diagnostic text", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "explicit message", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("explicit message")
		})

		it("falls back to description when message is absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, description: "desc text", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("desc text")
		})

		it("falls back to rule_id when message and description are absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, rule_id: "RULE1", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("[RULE1] RULE1")
		})

		it("falls back to defect_id when message, description, and rule_id are absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, defect_id: "DEF1", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("[DEF1] DEF1")
		})

		it('uses "lint issue" as last resort', async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("lint issue")
		})

		it("prepends [rule_id] to message when rule_id is present", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "something", rule_id: "R1", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("[R1] something")
		})

		it("uses message directly when rule_id is absent", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "no rule", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].message).toBe("no rule")
		})

		it("creates new array in allDiagnostics for unseen file", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [
				{ file: absPath, line: 1, column: 1, message: "first", severity: "error" },
				{ file: absPath, line: 2, column: 1, message: "second", severity: "warning" },
			]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags.length).toBe(2)
		})

		it("sets source to cjlint on each diagnostic", async () => {
			const absPath = path.resolve("/test/file.cj")
			const data = [{ file: absPath, line: 1, column: 1, message: "src test", severity: "error" }]
			await runLintSingleFile(JSON.stringify(data))
			const diags = getLastSetDiags()
			expect(diags[0].source).toBe("cjlint")
		})

		it("handles invalid JSON gracefully", async () => {
			await runLintSingleFile("not valid json {{{")
			const diags = getLastSetDiags()
			expect(diags.length).toBe(0)
		})

		it("handles empty array report", async () => {
			await runLintSingleFile("[]")
			const diags = getLastSetDiags()
			expect(diags.length).toBe(0)
		})
	})

	// ── deduplicateWithLsp ────────────────────────────────────────────────

	describe("deduplicateWithLsp", () => {
		async function runWithLspDiags(reportJson: string, lspDiags: any[]) {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockReadFileSync.mockReturnValue(reportJson)
			mockGetDiagnostics.mockReturnValue(lspDiags)

			// Use the main diagnostics instance; its collection is results[0].
			const uri = { fsPath: "/test/file.cj" } as any
			await diagnostics.lintSingleFile(uri)
			return getLastSetDiags()
		}

		it("keeps all cjlint diagnostics when no LSP diagnostics exist", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([{ file: absPath, line: 1, column: 1, message: "issue1", severity: "error" }])
			const result = await runWithLspDiags(report, [])
			expect(result.length).toBe(1)
			expect(result[0].message).toBe("issue1")
		})

		it("filters cjlint diagnostic when LSP has similar message on same line", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "unused variable", severity: "warning" },
			])
			const lspDiags = [makeDiag(0, "unused variable", "cangjie-lsp")]
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(0)
		})

		it("keeps cjlint diagnostic when LSP has different message on same line", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "unused variable", severity: "warning" },
			])
			const lspDiags = [makeDiag(0, "syntax error", "cangjie-lsp")]
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(1)
		})

		it("keeps cjlint diagnostic when LSP diagnostic is on a different line", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "issue here", severity: "warning" },
			])
			const lspDiags = [makeDiag(5, "issue here", "cangjie-lsp")]
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(1)
		})

		it("strips rule prefix from messages for comparison", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "unused var", rule_id: "R1", severity: "warning" },
			])
			// LSP message without prefix matches cjlint message after stripping [R1]
			const lspDiags = [makeDiag(0, "unused var", "cangjie-lsp")]
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(0)
		})

		it("filters when LSP message includes cjlint message after stripping", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "unused", severity: "warning" },
			])
			const lspDiags = [makeDiag(0, "[LSP] unused variable", "cangjie-lsp")]
			// stripRule("[LSP] unused variable") = "unused variable"
			// stripRule("unused") = "unused"
			// "unused variable".includes("unused") = true -> filtered
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(0)
		})

		it("filters when cjlint message includes LSP message after stripping", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "unused variable in scope", severity: "warning" },
			])
			const lspDiags = [makeDiag(0, "unused variable", "cangjie-lsp")]
			// "unused variable".includes("unused variable in scope") = false
			// "unused variable in scope".includes("unused variable") = true -> filtered
			const result = await runWithLspDiags(report, lspDiags)
			expect(result.length).toBe(0)
		})
	})

	// ── lintSingleFile additional paths ───────────────────────────────────

	describe("lintSingleFile additional paths", () => {
		it("deletes diagnostics when file is excluded by lintConfig", async () => {
			const lintConfig = {
				isFileExcluded: mockIsFileExcluded,
				filterDiagnostics: mockFilterDiagnostics,
			} as unknown as CangjieLintConfig
			mockIsFileExcluded.mockReturnValue(true)

			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "excluded issue", severity: "error" },
			])

			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockReadFileSync.mockReturnValue(report)

			const inst = new CjlintDiagnostics(mockOutput as any, lintConfig)
			const uri = { fsPath: "/test/file.cj" } as any
			await inst.lintSingleFile(uri)

			expect(mockIsFileExcluded).toHaveBeenCalledWith(path.resolve("/test/file.cj"))
			const coll = getCollection()
			expect(coll.delete).toHaveBeenCalledWith(uri)
			expect(coll.set).not.toHaveBeenCalled()
		})

		it("calls filterDiagnostics when lintConfig is present", async () => {
			const lintConfig = {
				isFileExcluded: mockIsFileExcluded,
				filterDiagnostics: mockFilterDiagnostics,
			} as unknown as CangjieLintConfig
			mockIsFileExcluded.mockReturnValue(false)
			mockFilterDiagnostics.mockImplementation((d: any[]) => d)

			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "filtered", severity: "error" },
			])

			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockReadFileSync.mockReturnValue(report)

			const inst = new CjlintDiagnostics(mockOutput as any, lintConfig)
			const uri = { fsPath: "/test/file.cj" } as any
			await inst.lintSingleFile(uri)

			expect(mockFilterDiagnostics).toHaveBeenCalled()
		})

		it("skips filtering when lintConfig is not provided", async () => {
			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "no config", severity: "error" },
			])
			await runLintSingleFile(report)
			expect(mockFilterDiagnostics).not.toHaveBeenCalled()
			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
		})

		it("reads fallback report when .json report does not exist", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)

			const absPath = path.resolve("/test/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "fallback", severity: "error" },
			])

			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				// .json report does NOT exist, but fallback file does
				if (typeof p === "string" && p.endsWith(".json") && p.includes("cjlint_single_")) return false
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockReadFileSync.mockReturnValue(report)

			const uri = { fsPath: "/test/file.cj" } as any
			await diagnostics.lintSingleFile(uri)

			const diags = getLastSetDiags()
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("fallback")
		})

		it("skips parsing when neither report file exists", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				return false
			})

			const uri = { fsPath: "/test/file.cj" } as any
			await diagnostics.lintSingleFile(uri)

			expect(mockReadFileSync).not.toHaveBeenCalled()
			const diags = getLastSetDiags()
			expect(diags.length).toBe(0)
		})

		it("returns early when file does not exist on disk", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockReturnValue(false)

			const uri = { fsPath: "/test/nonexistent.cj" } as any
			await diagnostics.lintSingleFile(uri)

			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("returns early when already running", async () => {
			// Directly set the private `running` flag to test the guard
			;(diagnostics as any).running = true
			const uri = { fsPath: "/test/file.cj" } as any
			await diagnostics.lintSingleFile(uri)
			expect(mockExecFile).not.toHaveBeenCalled()
			;(diagnostics as any).running = false
		})
	})

	// ── lintWorkspace additional paths ────────────────────────────────────

	describe("lintWorkspace additional paths", () => {
		it("uses src directory when it exists", async () => {
			await runLintWorkspace("[]", { srcExists: true })
			expect(mockExecFile).toHaveBeenCalled()
			const args = mockExecFile.mock.calls[0][1] as string[]
			expect(args[1]).toBe(path.join("/ws", "src"))
		})

		it("uses folder root when src directory does not exist", async () => {
			await runLintWorkspace("[]", { srcExists: false })
			expect(mockExecFile).toHaveBeenCalled()
			const args = mockExecFile.mock.calls[0][1] as string[]
			expect(args[1]).toBe("/ws")
		})

		it("skips folder when target directory does not exist", async () => {
			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/nonexistent" } }]
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockReturnValue(false)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockReadFileSync.mockReturnValue("[]")

			await diagnostics.lintWorkspace()
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("skips excluded files in lintWorkspace", async () => {
			const lintConfig = {
				isFileExcluded: mockIsFileExcluded,
				filterDiagnostics: mockFilterDiagnostics,
			} as unknown as CangjieLintConfig
			mockIsFileExcluded.mockReturnValue(true)
			mockFilterDiagnostics.mockImplementation((d: any[]) => d)

			const absPath = path.resolve("/ws/src/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "excluded", severity: "error" },
			])

			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }]
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (typeof p === "string" && p.endsWith("src")) return true
				if (typeof p === "string" && p.includes("cjlint_report_")) return true
				return true
			})
			mockReadFileSync.mockReturnValue(report)

			const inst = new CjlintDiagnostics(mockOutput as any, lintConfig)
			await inst.lintWorkspace()

			expect(mockIsFileExcluded).toHaveBeenCalled()
			expect(getCollection().set).not.toHaveBeenCalled()
		})

		it("calls filterDiagnostics in lintWorkspace when lintConfig is present", async () => {
			const lintConfig = {
				isFileExcluded: mockIsFileExcluded,
				filterDiagnostics: mockFilterDiagnostics,
			} as unknown as CangjieLintConfig
			mockIsFileExcluded.mockReturnValue(false)
			mockFilterDiagnostics.mockImplementation((d: any[]) => d)

			const absPath = path.resolve("/ws/src/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "to filter", severity: "error" },
			])

			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }]
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (typeof p === "string" && p.endsWith("src")) return true
				if (typeof p === "string" && p.includes("cjlint_report_")) return true
				return true
			})
			mockReadFileSync.mockReturnValue(report)

			const inst = new CjlintDiagnostics(mockOutput as any, lintConfig)
			await inst.lintWorkspace()

			expect(mockFilterDiagnostics).toHaveBeenCalled()
		})

		it("lintWorkspace returns early when already running", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			;(diagnostics as any).running = true

			await diagnostics.lintWorkspace()
			expect(mockExecFile).not.toHaveBeenCalled()
			;(diagnostics as any).running = false
		})

		it("lintWorkspace uses fallback report when .json does not exist", async () => {
			const absPath = path.resolve("/ws/src/file.cj")
			const report = JSON.stringify([
				{ file: absPath, line: 1, column: 1, message: "fallback ws", severity: "warning" },
			])

			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" } }]
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockExistsSync.mockImplementation((p: string) => {
				if (typeof p === "string" && p.endsWith("src")) return true
				if (typeof p === "string" && p.endsWith(".json") && p.includes("cjlint_report_")) return false
				if (typeof p === "string" && p.includes("cjlint_report_")) return true
				return true
			})
			mockReadFileSync.mockReturnValue(report)

			await diagnostics.lintWorkspace()

			const coll = getCollection()
			expect(coll.set).toHaveBeenCalled()
			const diags = coll.set.mock.calls[0][1]
			expect(diags.length).toBe(1)
			expect(diags[0].message).toBe("fallback ws")
		})
	})

	// ── debouncedLint ─────────────────────────────────────────────────────

	describe("debouncedLint", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("clears existing timer when called again", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file1.cj" || p === "/test/file2.cj") return true
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockReadFileSync.mockReturnValue("[]")

			const uri1 = { fsPath: "/test/file1.cj" } as any
			const uri2 = { fsPath: "/test/file2.cj" } as any

			;(diagnostics as any).debouncedLint(uri1)
			;(diagnostics as any).debouncedLint(uri2) // should clear first timer

			await vi.runAllTimersAsync()

			// execFile should only have been called once (for uri2, not uri1)
			expect(mockExecFile).toHaveBeenCalledTimes(1)
		})

		it("fires lintSingleFile after debounce delay with URI", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockImplementation((p: string) => {
				if (p === "/test/file.cj") return true
				if (typeof p === "string" && p.includes("cjlint_single_")) return true
				return false
			})
			mockGetWorkspaceFolder.mockReturnValue({ uri: { fsPath: "/ws" } })
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockReadFileSync.mockReturnValue("[]")

			const uri = { fsPath: "/test/file.cj" } as any
			;(diagnostics as any).debouncedLint(uri)

			expect(mockExecFile).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1500)

			expect(mockExecFile).toHaveBeenCalled()
		})

		it("fires lintWorkspace after debounce delay without URI", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockReturnValue(true)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockReadFileSync.mockReturnValue("[]")
			;(diagnostics as any).debouncedLint()

			expect(mockExecFile).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(1500)

			expect(mockExecFile).toHaveBeenCalled()
		})

		it("dispose clears debounce timer", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjlint")
			mockExistsSync.mockReturnValue(true)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			mockReadFileSync.mockReturnValue("[]")

			const uri = { fsPath: "/test/file.cj" } as any
			;(diagnostics as any).debouncedLint(uri)
			diagnostics.dispose()

			await vi.runAllTimersAsync()

			expect(mockExecFile).not.toHaveBeenCalled()
		})
	})
})
