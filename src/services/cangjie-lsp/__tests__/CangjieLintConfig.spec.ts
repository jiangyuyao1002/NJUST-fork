import * as path from "path"
import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockExistsSync,
	mockReadFileSync,
	mockCreateDiagnosticCollection,
	mockAsRelativePath,
	mockCreateFileSystemWatcher,
	mockOnDidSaveTextDocument,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockCreateDiagnosticCollection: vi.fn(),
	mockAsRelativePath: vi.fn(),
	mockCreateFileSystemWatcher: vi.fn(),
	mockOnDidSaveTextDocument: vi.fn(),
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
		source: string = ""
		constructor(
			public range: unknown,
			public message: string,
			public severity: number,
		) {}
	},
	Range: class {
		constructor(
			public startLine: number,
			public startChar: number,
			public endLine: number,
			public endChar: number,
		) {}
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
	},
	languages: {
		createDiagnosticCollection: mockCreateDiagnosticCollection,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		asRelativePath: mockAsRelativePath,
		createFileSystemWatcher: mockCreateFileSystemWatcher,
		onDidSaveTextDocument: mockOnDidSaveTextDocument,
	},
	RelativePattern: class {
		constructor(
			public base: string,
			public pattern: string,
		) {}
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import { CangjieLintConfig } from "../CangjieLintConfig"
import { TelemetryService } from "@njust-ai/telemetry"

describe("CangjieLintConfig", () => {
	let config: CangjieLintConfig
	let mockOutput: any
	let mockDiagnosticCollection: any
	let mockWatcher: any
	let watcherChangeCb: () => void
	let watcherCreateCb: (uri: any) => void
	let watcherDeleteCb: () => void
	let saveDocCb: (doc: any) => void

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		mockDiagnosticCollection = {
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		}
		mockCreateDiagnosticCollection.mockReturnValue(mockDiagnosticCollection)
		watcherChangeCb = () => {}
		watcherCreateCb = () => {}
		watcherDeleteCb = () => {}
		mockWatcher = {
			onDidChange: vi.fn((cb: any) => {
				watcherChangeCb = cb
			}),
			onDidCreate: vi.fn((cb: any) => {
				watcherCreateCb = cb
			}),
			onDidDelete: vi.fn((cb: any) => {
				watcherDeleteCb = cb
			}),
			dispose: vi.fn(),
		}
		mockCreateFileSystemWatcher.mockReturnValue(mockWatcher)
		mockOnDidSaveTextDocument.mockImplementation((cb: any) => {
			saveDocCb = cb
			return { dispose: vi.fn() }
		})
		mockAsRelativePath.mockImplementation((p: string) => p)
		mockExistsSync.mockReset()
		mockExistsSync.mockImplementation(() => false)
		mockReadFileSync.mockReset()
		config = new CangjieLintConfig(mockOutput)
	})

	// helper to initialize with a config file
	async function initWithConfig(cfg: object) {
		mockExistsSync.mockImplementation((p: string) => p.includes(".cjlintrc"))
		mockReadFileSync.mockReturnValue(JSON.stringify(cfg))
		await config.initialize()
	}

	// ── constructor ──────────────────────────────────────────────────

	describe("constructor", () => {
		it("creates diagnostic collection", () => {
			expect(mockCreateDiagnosticCollection).toHaveBeenCalledWith("cjlint-custom")
		})

		it("adds diagnostic collection to disposables", () => {
			config.dispose()
			expect(mockDiagnosticCollection.dispose).toHaveBeenCalled()
		})
	})

	// ── initialize ───────────────────────────────────────────────────

	describe("initialize", () => {
		it("returns early when no workspace folders", async () => {
			const origFolders = (await import("vscode")).workspace.workspaceFolders
			;(await import("vscode")).workspace.workspaceFolders = undefined as any
			await config.initialize()
			expect(mockCreateFileSystemWatcher).not.toHaveBeenCalled()
			;(await import("vscode")).workspace.workspaceFolders = origFolders
		})

		it("finds .cjlintrc config file", async () => {
			mockExistsSync.mockImplementation((p: string) => p.endsWith(".cjlintrc"))
			mockReadFileSync.mockReturnValue("{}")
			await config.initialize()
			expect((config as any).configPath).toMatch(/\.cjlintrc$/)
		})

		it("finds .cjlintrc.json when .cjlintrc not found", async () => {
			mockExistsSync.mockImplementation((p: string) => p.endsWith(".cjlintrc.json"))
			mockReadFileSync.mockReturnValue("{}")
			await config.initialize()
			expect((config as any).configPath).toMatch(/\.cjlintrc\.json$/)
		})

		it("creates file system watcher", async () => {
			await config.initialize()
			expect(mockCreateFileSystemWatcher).toHaveBeenCalled()
		})

		it("registers onDidSaveTextDocument", async () => {
			await config.initialize()
			expect(mockOnDidSaveTextDocument).toHaveBeenCalled()
		})

		describe("watcher callbacks", () => {
			it("onDidChange: reloads config", async () => {
				await initWithConfig({ rules: {} })
				mockReadFileSync.mockReturnValue(
					JSON.stringify({
						rules: { "new.rule": { severity: "error" } },
					}),
				)
				watcherChangeCb()
				expect(config.currentConfig.rules).toHaveProperty("new.rule")
			})

			it("onDidCreate: sets configPath and reloads", async () => {
				await config.initialize()
				mockReadFileSync.mockReturnValue(
					JSON.stringify({
						rules: { "created.rule": { severity: "warning" } },
					}),
				)
				mockExistsSync.mockImplementation((p: string) => p.includes(".cjlintrc"))
				const createPath = path.join("/ws", ".cjlintrc")
				watcherCreateCb({ fsPath: createPath })
				expect((config as any).configPath).toBe(createPath)
				expect(config.currentConfig.rules).toHaveProperty("created.rule")
			})

			it("onDidDelete: resets to default config and clears diagnostics", async () => {
				await initWithConfig({ rules: { "some.rule": { severity: "off" } } })
				expect(config.isRuleSuppressed("some.rule")).toBe(true)
				watcherDeleteCb()
				expect(config.isRuleSuppressed("some.rule")).toBe(false)
				expect((config as any).configPath).toBeUndefined()
				expect(mockDiagnosticCollection.clear).toHaveBeenCalled()
			})
		})

		describe("onDidSaveTextDocument callback", () => {
			it("runs custom rules for cangjie language", async () => {
				await initWithConfig({
					custom: [{ id: "r1", pattern: "foo", severity: "error", message: "no foo" }],
				})
				const doc = {
					uri: { fsPath: "/ws/test.cj" },
					fileName: "/ws/test.cj",
					languageId: "cangjie",
					getText: () => "foo bar",
				}
				saveDocCb(doc)
				expect(mockDiagnosticCollection.set).toHaveBeenCalled()
			})

			it("runs custom rules for .cj file extension", async () => {
				await initWithConfig({
					custom: [{ id: "r1", pattern: "bar", severity: "warning", message: "no bar" }],
				})
				const doc = {
					uri: { fsPath: "/ws/test.cj" },
					fileName: "/ws/test.cj",
					languageId: "plaintext",
					getText: () => "bar baz",
				}
				saveDocCb(doc)
				expect(mockDiagnosticCollection.set).toHaveBeenCalled()
			})

			it("ignores non-cangjie files", async () => {
				await initWithConfig({
					custom: [{ id: "r1", pattern: "foo", severity: "error", message: "no foo" }],
				})
				const doc = {
					uri: { fsPath: "/ws/test.ts" },
					fileName: "/ws/test.ts",
					languageId: "typescript",
					getText: () => "foo",
				}
				saveDocCb(doc)
				expect(mockDiagnosticCollection.set).not.toHaveBeenCalled()
			})
		})
	})

	// ── loadConfig ───────────────────────────────────────────────────

	describe("loadConfig", () => {
		it("loads valid config with all fields", async () => {
			await initWithConfig({
				rules: { r1: { severity: "error" } },
				custom: [{ id: "c1", pattern: "x", severity: "warning", message: "msg" }],
				exclude: ["test/*"],
			})
			expect(config.currentConfig.rules).toHaveProperty("r1")
			expect(config.currentConfig.custom).toHaveLength(1)
			expect(config.currentConfig.exclude).toHaveLength(1)
		})

		it("logs config info on successful load", async () => {
			await initWithConfig({
				rules: { r1: { severity: "error" }, r2: { severity: "warning" } },
				custom: [{ id: "c1", pattern: "x", severity: "warning", message: "msg" }],
			})
			expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("2 rule overrides"))
			expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("1 custom rules"))
		})

		it("falls back to default on invalid JSON", async () => {
			mockExistsSync.mockImplementation((p: string) => p.includes(".cjlintrc"))
			mockReadFileSync.mockReturnValue("invalid json{{{")
			await config.initialize()
			expect(config.currentConfig.rules).toEqual({})
			expect(config.currentConfig.custom).toEqual([])
			expect(config.currentConfig.exclude).toEqual([])
		})

		it("reports telemetry error on parse failure", async () => {
			mockExistsSync.mockImplementation((p: string) => p.includes(".cjlintrc"))
			mockReadFileSync.mockReturnValue("bad")
			await config.initialize()
			expect(TelemetryService.reportError).toHaveBeenCalled()
		})

		it("logs parse failure to output channel", async () => {
			mockExistsSync.mockImplementation((p: string) => p.includes(".cjlintrc"))
			mockReadFileSync.mockReturnValue("bad")
			await config.initialize()
			expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"))
		})

		it("handles non-array custom field", async () => {
			await initWithConfig({ custom: "not-an-array" })
			expect(config.currentConfig.custom).toEqual([])
		})

		it("handles non-array exclude field", async () => {
			await initWithConfig({ exclude: 42 })
			expect(config.currentConfig.exclude).toEqual([])
		})

		it("defaults rules to empty when not provided", async () => {
			await initWithConfig({})
			expect(config.currentConfig.rules).toEqual({})
		})

		it("resets config when file no longer exists", async () => {
			await initWithConfig({ rules: { r1: { severity: "error" } } })
			// Now file doesn't exist
			mockExistsSync.mockReturnValue(false)
			;(config as any).loadConfig()
			expect(config.currentConfig.rules).toEqual({})
		})
	})

	// ── isRuleSuppressed ─────────────────────────────────────────────

	describe("isRuleSuppressed", () => {
		it("returns false when no rules configured", () => {
			expect(config.isRuleSuppressed("some.rule")).toBe(false)
		})

		it("returns true when rule severity is off", async () => {
			await initWithConfig({ rules: { "some.rule": { severity: "off" } } })
			expect(config.isRuleSuppressed("some.rule")).toBe(true)
		})

		it("returns false when rule severity is error", async () => {
			await initWithConfig({ rules: { "some.rule": { severity: "error" } } })
			expect(config.isRuleSuppressed("some.rule")).toBe(false)
		})

		it("returns false when rule severity is warning", async () => {
			await initWithConfig({ rules: { "some.rule": { severity: "warning" } } })
			expect(config.isRuleSuppressed("some.rule")).toBe(false)
		})

		it("returns false for unknown rule id", async () => {
			await initWithConfig({ rules: { known: { severity: "off" } } })
			expect(config.isRuleSuppressed("unknown")).toBe(false)
		})
	})

	// ── getEffectiveSeverity ─────────────────────────────────────────

	describe("getEffectiveSeverity", () => {
		it("returns undefined when rule not overridden", () => {
			expect(config.getEffectiveSeverity("unknown.rule")).toBeUndefined()
		})

		it("returns Error for severity error", async () => {
			await initWithConfig({ rules: { r1: { severity: "error" } } })
			expect(config.getEffectiveSeverity("r1")).toBe(0)
		})

		it("returns Warning for severity warning", async () => {
			await initWithConfig({ rules: { r1: { severity: "warning" } } })
			expect(config.getEffectiveSeverity("r1")).toBe(1)
		})

		it("returns Information for severity info", async () => {
			await initWithConfig({ rules: { r1: { severity: "info" } } })
			expect(config.getEffectiveSeverity("r1")).toBe(2)
		})

		it("returns undefined for severity off", async () => {
			await initWithConfig({ rules: { r1: { severity: "off" } } })
			expect(config.getEffectiveSeverity("r1")).toBeUndefined()
		})
	})

	// ── isFileExcluded ───────────────────────────────────────────────

	describe("isFileExcluded", () => {
		it("returns false when no exclude patterns", () => {
			expect(config.isFileExcluded("/test/file.cj")).toBe(false)
		})

		it("matches glob pattern with *", async () => {
			await initWithConfig({ exclude: ["test/*.cj"] })
			mockAsRelativePath.mockReturnValue("test/foo.cj")
			expect(config.isFileExcluded("/ws/test/foo.cj")).toBe(true)
		})

		it("does not match glob when pattern differs", async () => {
			await initWithConfig({ exclude: ["test/*.cj"] })
			mockAsRelativePath.mockReturnValue("src/main.cj")
			expect(config.isFileExcluded("/ws/src/main.cj")).toBe(false)
		})

		it("matches prefix pattern (no wildcard)", async () => {
			await initWithConfig({ exclude: ["generated"] })
			mockAsRelativePath.mockReturnValue("generated/output.cj")
			expect(config.isFileExcluded("/ws/generated/output.cj")).toBe(true)
		})

		it("prefix does not match different path", async () => {
			await initWithConfig({ exclude: ["generated"] })
			mockAsRelativePath.mockReturnValue("src/main.cj")
			expect(config.isFileExcluded("/ws/src/main.cj")).toBe(false)
		})

		it("handles ? metacharacter in glob with *", async () => {
			await initWithConfig({ exclude: ["test?*.cj"] })
			mockAsRelativePath.mockReturnValue("test1abc.cj")
			expect(config.isFileExcluded("/ws/test1abc.cj")).toBe(true)
		})

		it("normalizes backslashes to forward slashes", async () => {
			await initWithConfig({ exclude: ["test/*"] })
			mockAsRelativePath.mockReturnValue("test\\file.cj")
			expect(config.isFileExcluded("/ws/test/file.cj")).toBe(true)
		})

		it("handles invalid regex pattern gracefully", async () => {
			await initWithConfig({ exclude: ["[invalid*"] })
			mockAsRelativePath.mockReturnValue("something")
			expect(() => config.isFileExcluded("/ws/something")).not.toThrow()
		})

		it("handles multiple exclude patterns", async () => {
			await initWithConfig({ exclude: ["build/*", "generated"] })
			mockAsRelativePath.mockReturnValue("build/output.cj")
			expect(config.isFileExcluded("/ws/build/output.cj")).toBe(true)
			mockAsRelativePath.mockReturnValue("generated/file.cj")
			expect(config.isFileExcluded("/ws/generated/file.cj")).toBe(true)
			mockAsRelativePath.mockReturnValue("src/main.cj")
			expect(config.isFileExcluded("/ws/src/main.cj")).toBe(false)
		})
	})

	// ── filterDiagnostics ────────────────────────────────────────────

	describe("filterDiagnostics", () => {
		it("returns all diagnostics when no rules configured", () => {
			const diags = [
				{ message: "[RULE001] error", severity: 0, range: {} },
				{ message: "no rule id", severity: 1, range: {} },
			] as any[]
			expect(config.filterDiagnostics(diags)).toHaveLength(2)
		})

		it("filters out suppressed rules", async () => {
			await initWithConfig({ rules: { RULE001: { severity: "off" } } })
			const diags = [
				{ message: "[RULE001] error", severity: 0, range: {} },
				{ message: "[RULE002] warning", severity: 1, range: {} },
			] as any[]
			const result = config.filterDiagnostics(diags)
			expect(result).toHaveLength(1)
			expect(result[0].message).toContain("RULE002")
		})

		it("overrides severity for non-suppressed rules", async () => {
			await initWithConfig({ rules: { RULE001: { severity: "error" } } })
			const diags = [
				{
					message: "[RULE001] warning",
					severity: 1,
					range: { startLine: 0, startChar: 0, endLine: 0, endChar: 5 },
				},
			] as any[]
			const result = config.filterDiagnostics(diags)
			expect(result).toHaveLength(1)
			expect(result[0].severity).toBe(0) // Error
		})

		it("keeps diagnostics without rule id unchanged", () => {
			const diag = { message: "plain error message", severity: 0, range: {} } as any
			const result = config.filterDiagnostics([diag])
			expect(result).toHaveLength(1)
			expect(result[0]).toBe(diag) // same reference
		})

		it("handles dotted rule ids", async () => {
			await initWithConfig({ rules: { "lint.style.no_tabs": { severity: "info" } } })
			const diags = [
				{
					message: "[lint.style.no_tabs] use spaces",
					severity: 1,
					range: { startLine: 0, startChar: 0, endLine: 0, endChar: 1 },
				},
			] as any[]
			const result = config.filterDiagnostics(diags)
			expect(result).toHaveLength(1)
			expect(result[0].severity).toBe(2) // Information
		})

		it("does not override severity when rule has no override", () => {
			const diag = { message: "[UNKNOWN] something", severity: 1, range: {} } as any
			const result = config.filterDiagnostics([diag])
			expect(result[0]).toBe(diag) // unchanged reference
		})
	})

	// ── runCustomRules ───────────────────────────────────────────────

	describe("runCustomRules", () => {
		it("clears diagnostics when no custom rules", () => {
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "hello world",
			} as any
			config.runCustomRules(doc)
			expect(mockDiagnosticCollection.delete).toHaveBeenCalledWith(doc.uri)
		})

		it("produces diagnostics for matching patterns", async () => {
			await initWithConfig({
				custom: [{ id: "no-println", pattern: "println", severity: "warning", message: "Use logger" }],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => 'println("hello")',
			} as any
			config.runCustomRules(doc)
			expect(mockDiagnosticCollection.set).toHaveBeenCalledWith(
				doc.uri,
				expect.arrayContaining([expect.objectContaining({ message: "[no-println] Use logger" })]),
			)
		})

		it("handles multiple matches on different lines", async () => {
			await initWithConfig({
				custom: [{ id: "no-todo", pattern: "TODO", severity: "info", message: "Resolve TODO" }],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "// TODO: fix\nsome code\n// TODO: later",
			} as any
			config.runCustomRules(doc)
			const calls = mockDiagnosticCollection.set.mock.calls
			expect(calls[0][1]).toHaveLength(2)
		})

		it("skips excluded files", async () => {
			await initWithConfig({
				custom: [{ id: "r1", pattern: "x", severity: "error", message: "no x" }],
				exclude: ["gen/*"],
			})
			mockAsRelativePath.mockReturnValue("gen/output.cj")
			const doc = {
				uri: { fsPath: "/ws/gen/output.cj" },
				fileName: "/ws/gen/output.cj",
				getText: () => "x",
			} as any
			config.runCustomRules(doc)
			expect(mockDiagnosticCollection.delete).toHaveBeenCalledWith(doc.uri)
			expect(mockDiagnosticCollection.set).not.toHaveBeenCalled()
		})

		it("skips invalid regex patterns", async () => {
			await initWithConfig({
				custom: [{ id: "bad", pattern: "[invalid regex", severity: "error", message: "msg" }],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "some text",
			} as any
			expect(() => config.runCustomRules(doc)).not.toThrow()
			expect(mockDiagnosticCollection.set).toHaveBeenCalledWith(doc.uri, [])
		})

		it("skips rules with severity off", async () => {
			await initWithConfig({
				custom: [{ id: "r1", pattern: "foo", severity: "off", message: "skip" }],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "foo bar",
			} as any
			config.runCustomRules(doc)
			expect(mockDiagnosticCollection.set).toHaveBeenCalledWith(doc.uri, [])
		})

		it("sets source to cjlint-custom on diagnostics", async () => {
			await initWithConfig({
				custom: [{ id: "r1", pattern: "bar", severity: "error", message: "no bar" }],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "bar",
			} as any
			config.runCustomRules(doc)
			const diags = mockDiagnosticCollection.set.mock.calls[0][1]
			expect(diags[0].source).toBe("cjlint-custom")
		})

		it("handles multiple custom rules", async () => {
			await initWithConfig({
				custom: [
					{ id: "r1", pattern: "foo", severity: "error", message: "no foo" },
					{ id: "r2", pattern: "bar", severity: "warning", message: "no bar" },
				],
			})
			const doc = {
				uri: { fsPath: "/ws/test.cj" },
				fileName: "/ws/test.cj",
				getText: () => "foo bar",
			} as any
			config.runCustomRules(doc)
			const diags = mockDiagnosticCollection.set.mock.calls[0][1]
			expect(diags).toHaveLength(2)
		})
	})

	// ── currentConfig ────────────────────────────────────────────────

	describe("currentConfig", () => {
		it("returns default config initially", () => {
			expect(config.currentConfig).toEqual({ rules: {}, custom: [], exclude: [] })
		})

		it("returns loaded config after initialize", async () => {
			await initWithConfig({ rules: { r1: { severity: "error" } } })
			expect(config.currentConfig.rules).toHaveProperty("r1")
		})
	})

	// ── dispose ──────────────────────────────────────────────────────

	describe("dispose", () => {
		it("disposes all registered disposables", () => {
			config.dispose()
			expect(mockDiagnosticCollection.dispose).toHaveBeenCalled()
		})

		it("does not throw", () => {
			expect(() => config.dispose()).not.toThrow()
		})
	})
})
