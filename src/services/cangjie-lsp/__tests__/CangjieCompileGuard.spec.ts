import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import * as fs from "fs"

// Use vi.hoisted so the mock is available when vi.mock factories run
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))

vi.mock("vscode", () => ({
	EventEmitter: class {
		fire() {}
		dispose() {}
		get event() {
			return () => ({ dispose: vi.fn() })
		}
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showErrorMessage: vi.fn().mockResolvedValue(undefined),
		visibleTextEditors: [],
	},
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		getWorkspaceFolder: vi.fn(),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
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
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
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
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	commands: {
		executeCommand: vi.fn(),
	},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn().mockReturnValue(false),
			readFileSync: vi.fn(),
			writeFileSync: vi.fn(),
		},
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
	}
})

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("util", () => ({
	promisify:
		(fn: (...args: any[]) => any) =>
		(...args: any[]) =>
			fn(...args),
}))

vi.mock("os", () => ({
	tmpdir: vi.fn().mockReturnValue("/tmp"),
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("../cjpmTreeForPrompt", () => ({
	getCjpmTreeSummaryForPrompt: vi.fn().mockResolvedValue(""),
}))

vi.mock("../cangjieCompileHistory", () => ({
	recordCompileHistoryEvent: vi.fn(),
}))

vi.mock("../CangjieErrorAnalyzer", () => ({
	analyzeCompileOutput: vi.fn().mockReturnValue([]),
	formatAnalysisSummary: vi.fn().mockReturnValue(""),
	getFixDirectiveForLearning: vi.fn().mockReturnValue(null),
	normalizeErrorPattern: vi.fn().mockReturnValue(""),
}))

vi.mock("../../../core/prompts/sections/cangjie-context", () => ({
	invalidateCangjieL3ContextCache: vi.fn(),
	recordLearnedFix: vi.fn(),
	recordLearnedFailure: vi.fn(),
}))

vi.mock("../safeUnlink", () => ({
	safeUnlink: vi.fn(),
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../../shared/package", () => ({
	Package: { name: "roo-code", resolve: vi.fn().mockReturnValue(null) },
}))

import { CangjieCompileGuard } from "../CangjieCompileGuard"
import { resolveCangjieToolPath } from "../cangjieToolUtils"
import { recordCompileHistoryEvent } from "../cangjieCompileHistory"
import {
	invalidateCangjieL3ContextCache,
	recordLearnedFix,
	recordLearnedFailure,
} from "../../../core/prompts/sections/cangjie-context"
import { analyzeCompileOutput } from "../CangjieErrorAnalyzer"
import { safeUnlink } from "../safeUnlink"

describe("CangjieCompileGuard", () => {
	let guard: CangjieCompileGuard
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(resolveCangjieToolPath).mockReturnValue(undefined)
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		guard = new CangjieCompileGuard(mockOutput)
	})

	describe("constructor", () => {
		it("creates instance without throwing", () => {
			expect(guard).toBeDefined()
		})
	})

	describe("setMetricsCollector", () => {
		it("accepts a collector", () => {
			const mockCollector = { recordBuild: vi.fn(), recordErrorCategory: vi.fn() } as any
			guard.setMetricsCollector(mockCollector)
			expect((guard as any).metricsCollector).toBe(mockCollector)
		})

		it("accepts undefined to clear collector", () => {
			guard.setMetricsCollector(undefined)
			expect((guard as any).metricsCollector).toBeUndefined()
		})
	})

	describe("onCompile", () => {
		it("is an event", () => {
			expect(typeof guard.onCompile).toBe("function")
		})
	})

	describe("dispose", () => {
		it("disposes without error and cleans up internal state", () => {
			expect(() => guard.dispose()).not.toThrow()
			// Internal maps should be cleared
			expect((guard as any).compileDebounceByCwd.size).toBe(0)
			expect((guard as any).lintReportUriByCwd.size).toBe(0)
		})
	})

	// ── execBuild (deep tests through compileImpl) ──

	describe("execBuild", () => {
		beforeEach(() => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true) // target/ exists
		})

		it("returns success with stdout+stderr on build success", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "Build OK\n", stderr: "warning: something\n" })
			const result = await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect(result.success).toBe(true)
			expect(result.output).toContain("Build OK")
			expect(result.output).toContain("warning: something")
			expect(result.errorCount).toBe(0)
			expect(result.errorLocations).toEqual([])
		})

		it("clears lastErrors on success", async () => {
			// Pre-populate lastErrors
			;(guard as any).lastErrors.set("old:1", "old error")
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })
			await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect((guard as any).lastErrors.size).toBe(0)
		})

		it("parses CJC error locations from build output on failure", async () => {
			const err: any = new Error("Build failed")
			err.stdout = ""
			err.stderr = "==> src/main.cj:10:5: error: undefined variable\n==> src/util.cj:20:3: error: type mismatch"
			mockExecFile.mockRejectedValueOnce(err)

			const result = await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect(result.success).toBe(false)
			expect(result.errorLocations).toHaveLength(2)
			expect(result.errorLocations[0]).toEqual({ file: "src/main.cj", line: 10, col: 5 })
			expect(result.errorLocations[1]).toEqual({ file: "src/util.cj", line: 20, col: 3 })
			expect(result.errorCount).toBe(2)
		})

		it("stores normalized error messages in lastErrors map on failure", async () => {
			const err: any = new Error("Build failed")
			err.stdout = ""
			err.stderr = "==> src/main.cj:10:5: error: undefined variable"
			mockExecFile.mockRejectedValueOnce(err)

			await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect((guard as any).lastErrors.has("src/main.cj:10")).toBe(true)
		})

		it("returns errorCount 1 when build fails with no parseable locations", async () => {
			const err: any = new Error("Build failed")
			err.stdout = "some opaque error"
			err.stderr = ""
			mockExecFile.mockRejectedValueOnce(err)

			const result = await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect(result.success).toBe(false)
			expect(result.errorCount).toBe(1)
			expect(result.errorLocations).toEqual([])
		})

		it("clears lastErrors before populating new ones on failure", async () => {
			;(guard as any).lastErrors.set("old:1", "old error")
			const err: any = new Error("Build failed")
			err.stdout = ""
			err.stderr = "==> new.cj:5:1: err"
			mockExecFile.mockRejectedValueOnce(err)

			await (guard as any).execBuild("/usr/bin/cjpm", ["build"], "/ws")
			expect((guard as any).lastErrors.has("old:1")).toBe(false)
			expect((guard as any).lastErrors.has("new.cj:5")).toBe(true)
		})
	})

	// ── compileImpl (core pipeline) ──

	describe("compileImpl", () => {
		beforeEach(() => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true) // target/ exists, cjpm.toml exists
			vi.mocked(fs.readFileSync).mockReturnValue('[package]\nname = "test"')
		})

		it("returns failure and shows error when cjpm not found", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue(undefined)
			const result = await guard.compile("/ws")
			expect(result.success).toBe(false)
			expect(result.output).toContain("cjpm not found")
			expect(vscode.window.showErrorMessage).toHaveBeenCalled()
		})

		it("records compile history event on cjpm not found", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue(undefined)
			await guard.compile("/ws")
			expect(recordCompileHistoryEvent).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: "/ws", success: false }),
			)
		})

		it("runs successful incremental build and fires lifecycle events", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "Build OK", stderr: "" })
			const result = await guard.compile("/ws")

			expect(result.success).toBe(true)
			expect(result.incremental).toBe(true)
			expect(mockExecFile).toHaveBeenCalledWith(
				"/usr/bin/cjpm",
				["build", "-i"],
				expect.objectContaining({ cwd: "/ws" }),
			)
		})

		it("records metrics on successful build", async () => {
			const mockCollector = { recordBuild: vi.fn(), recordErrorCategory: vi.fn() } as any
			guard.setMetricsCollector(mockCollector)
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await guard.compile("/ws")
			expect(mockCollector.recordBuild).toHaveBeenCalledWith(
				expect.objectContaining({ success: true }),
				expect.any(Number),
			)
		})

		it("invalidates L3 context cache after build", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })
			await guard.compile("/ws")
			expect(invalidateCangjieL3ContextCache).toHaveBeenCalled()
		})

		it("records compile history event after build", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })
			await guard.compile("/ws")
			expect(recordCompileHistoryEvent).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: "/ws", success: true }),
			)
		})

		it("falls back to full build when incremental fails", async () => {
			// First call: incremental build fails
			const incrErr: any = new Error("Incremental failed")
			incrErr.stdout = ""
			incrErr.stderr = "==> src/main.cj:5:1: error"
			mockExecFile.mockRejectedValueOnce(incrErr)
			// Second call: full build succeeds
			mockExecFile.mockResolvedValueOnce({ stdout: "Full build OK", stderr: "" })

			const result = await guard.compile("/ws")
			expect(result.success).toBe(true)
			expect(result.incremental).toBe(false)
			expect(mockExecFile).toHaveBeenCalledTimes(2)
			// First call: incremental
			expect(mockExecFile).toHaveBeenNthCalledWith(1, "/usr/bin/cjpm", ["build", "-i"], expect.anything())
			// Second call: full
			expect(mockExecFile).toHaveBeenNthCalledWith(2, "/usr/bin/cjpm", ["build"], expect.anything())
		})

		it("disables incremental after incremental build failure", async () => {
			const incrErr: any = new Error("fail")
			incrErr.stdout = ""
			incrErr.stderr = ""
			mockExecFile.mockRejectedValueOnce(incrErr)
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await guard.compile("/ws")
			expect((guard as any).incrementalAvailable).toBe(false)
			expect((guard as any).fullBuildCountSinceIncrementalFailure).toBe(0)
		})

		it("returns failure when both incremental and full build fail", async () => {
			const incrErr: any = new Error("incr fail")
			incrErr.stdout = ""
			incrErr.stderr = "==> a.cj:1:1: err"
			const fullErr: any = new Error("full fail")
			fullErr.stdout = ""
			fullErr.stderr = "==> b.cj:2:2: err"
			mockExecFile.mockRejectedValueOnce(incrErr)
			mockExecFile.mockRejectedValueOnce(fullErr)

			const result = await guard.compile("/ws")
			expect(result.success).toBe(false)
			expect(result.incremental).toBe(false)
		})

		it("records error categories when build fails", async () => {
			const mockCollector = { recordBuild: vi.fn(), recordErrorCategory: vi.fn() } as any
			guard.setMetricsCollector(mockCollector)
			vi.mocked(analyzeCompileOutput).mockReturnValueOnce([{ category: "type_error" } as any])

			const err: any = new Error("fail")
			err.stdout = ""
			err.stderr = "type error output"
			mockExecFile.mockRejectedValueOnce(err)

			await guard.compile("/ws")
			expect(mockCollector.recordErrorCategory).toHaveBeenCalledWith("type_error")
		})

		it("uses full build when target/ directory does not exist", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false) // target/ missing
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			const result = await guard.compile("/ws")
			expect(result.success).toBe(true)
			expect(result.incremental).toBe(false)
			expect(mockExecFile).toHaveBeenCalledWith("/usr/bin/cjpm", ["build"], expect.anything())
		})

		it("updates lastFullBuildDurationMs on full build", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false) // force full build
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await guard.compile("/ws")
			expect((guard as any).lastFullBuildDurationMs).not.toBeNull()
			expect(typeof (guard as any).lastFullBuildDurationMs).toBe("number")
		})

		it("serializes concurrent compile calls for same cwd", async () => {
			let callCount = 0
			mockExecFile.mockImplementation(() => {
				callCount++
				return Promise.resolve({ stdout: `OK-${callCount}`, stderr: "" })
			})

			const r1 = await guard.compile("/ws")
			const r2 = await guard.compile("/ws")
			expect(r1.success).toBe(true)
			expect(r2.success).toBe(true)
			expect(callCount).toBe(2)
		})

		it("calls onCjpmBuildSucceededForLsp callback on success", async () => {
			const onSuccess = vi.fn()
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, undefined, undefined, onSuccess)
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("toml")
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await guard2.compile("/ws")
			expect(onSuccess).toHaveBeenCalledWith({ cwd: "/ws" })
		})

		it("stores toml hash after successful build", async () => {
			vi.mocked(fs.existsSync).mockImplementation((p: any) => {
				if (String(p).includes("cjpm.toml")) return true
				return true // target/ exists
			})
			vi.mocked(fs.readFileSync).mockReturnValue('[package]\nname = "myproj"')
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await guard.compile("/ws")
			expect((guard as any).lastCjpmTomlHash).toBeDefined()
		})
	})

	// ── formatFile (deep tests) ──

	describe("formatFile", () => {
		beforeEach(() => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjfmt")
		})

		it("returns formatted true when file content changed", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })
			vi.mocked(fs.existsSync).mockReturnValue(true) // tmp output exists
			vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
				if (String(p).includes("cjfmt_guard_")) return "formatted code"
				return "original code"
			})

			const result = await guard.formatFile("/test/file.cj")
			expect(result.formatted).toBe(true)
			expect(result.output).toBe("File formatted")
			expect(fs.writeFileSync).toHaveBeenCalledWith("/test/file.cj", "formatted code", "utf-8")
		})

		it("returns formatted false when file is already formatted", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("same code")

			const result = await guard.formatFile("/test/file.cj")
			expect(result.formatted).toBe(false)
			expect(result.output).toBe("Already formatted")
		})

		it("returns formatted false when no output produced", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })
			vi.mocked(fs.existsSync).mockReturnValue(false) // tmp output missing

			const result = await guard.formatFile("/test/file.cj")
			expect(result.formatted).toBe(false)
			expect(result.output).toBe("No output produced")
		})

		it("returns error message when cjfmt fails", async () => {
			mockExecFile.mockRejectedValueOnce(new Error("cjfmt crashed"))

			const result = await guard.formatFile("/test/file.cj")
			expect(result.formatted).toBe(false)
			expect(result.output).toContain("cjfmt crashed")
		})

		it("returns not formatted when cjfmt not found", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue(undefined)
			const result = await guard.formatFile("/test/file.cj")
			expect(result.formatted).toBe(false)
			expect(result.output).toContain("cjfmt not found")
		})

		it("cleans up temp file in finally block", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("same")

			await guard.formatFile("/test/file.cj")
			expect(safeUnlink).toHaveBeenCalled()
		})

		it("passes correct arguments to cjfmt", async () => {
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })
			vi.mocked(fs.existsSync).mockReturnValue(false)

			await guard.formatFile("/test/file.cj")
			expect(mockExecFile).toHaveBeenCalledWith(
				"/usr/bin/cjfmt",
				expect.arrayContaining(["-f", "/test/file.cj", "-o"]),
				expect.anything(),
			)
		})
	})

	// ── publishCompileDiagnostics (deep tests) ──

	describe("publishCompileDiagnostics", () => {
		it("does not throw when compileDiagnostics is undefined", () => {
			const guard2 = new CangjieCompileGuard(mockOutput)
			expect(() => {
				;(guard2 as any).publishCompileDiagnostics("/ws", [], "output", true)
			}).not.toThrow()
		})

		it("clears diagnostics when locations array is empty", () => {
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield* []
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			;(guard2 as any).publishCompileDiagnostics("/ws", [], "output", true)
			expect(mockDiagCollection.clear).toHaveBeenCalled()
		})

		it("creates diagnostics for each error location", () => {
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield* []
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			const locations = [
				{ file: "src/main.cj", line: 10, col: 5 },
				{ file: "src/util.cj", line: 20, col: 3 },
			]
			;(guard2 as any).publishCompileDiagnostics("/ws", locations, "build output here", false)
			expect(mockDiagCollection.set).toHaveBeenCalledTimes(2)
		})

		it("groups diagnostics by file for same-file errors", () => {
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield* []
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			const locations = [
				{ file: "src/main.cj", line: 10, col: 5 },
				{ file: "src/main.cj", line: 20, col: 1 },
			]
			;(guard2 as any).publishCompileDiagnostics("/ws", locations, "output", false)
			// Both locations are in the same file → only one set() call
			expect(mockDiagCollection.set).toHaveBeenCalledTimes(1)
			// But the diagnostic array should have 2 entries
			const callArgs = mockDiagCollection.set.mock.calls[0]
			expect(callArgs[1]).toHaveLength(2)
		})

		it("clears existing diagnostics for cwd before setting new ones", () => {
			const existingUri = { fsPath: "/ws/old.cj" }
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield [existingUri]
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			;(guard2 as any).publishCompileDiagnostics("/ws", [], "output", true)
			expect(mockDiagCollection.delete).toHaveBeenCalledWith(existingUri)
		})

		it("uses lastErrors message as diagnostic text when available", () => {
			;(guard as any).lastErrors.set("src/main.cj:10", "specific error message")
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield* []
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			;(guard2 as any).lastErrors.set("src/main.cj:10", "specific error message")
			;(guard2 as any).publishCompileDiagnostics(
				"/ws",
				[{ file: "src/main.cj", line: 10, col: 5 }],
				"generic output",
				false,
			)
			const diagArg = mockDiagCollection.set.mock.calls[0][1][0]
			expect(diagArg.message).toContain("specific error message")
		})
	})

	// ── registerSaveHook & runDebouncedPostSavePipeline ──

	describe("registerSaveHook", () => {
		it("registers a save handler", () => {
			guard.registerSaveHook()
			expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalled()
		})

		it("save handler ignores non-cangjie files", async () => {
			guard.registerSaveHook()
			const handler = vi.mocked(vscode.workspace.onDidSaveTextDocument).mock.calls[0][0] as (
				...args: any[]
			) => void
			const mockDoc = {
				languageId: "typescript",
				fileName: "test.ts",
				uri: { fsPath: "/ws/test.ts" },
			}
			await handler(mockDoc)
			// resolveCangjieToolPath should not be called for non-cangjie files
			expect(resolveCangjieToolPath).not.toHaveBeenCalled()
		})

		it("save handler ignores files outside workspace", async () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
			guard.registerSaveHook()
			const handler = vi.mocked(vscode.workspace.onDidSaveTextDocument).mock.calls[0][0] as (
				...args: any[]
			) => void
			const mockDoc = {
				languageId: "cangjie",
				fileName: "test.cj",
				uri: { fsPath: "/other/test.cj" },
			}
			await handler(mockDoc)
			expect(resolveCangjieToolPath).not.toHaveBeenCalled()
		})
	})

	describe("runDebouncedPostSavePipeline", () => {
		beforeEach(() => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("toml content")
		})

		it("records learned fixes for resolved errors on successful build", async () => {
			// Pre-populate lastErrors with a prior error
			;(guard as any).lastErrors.set("src/old.cj:5", "type mismatch error")

			// Set up lintReportUri
			;(guard as any).lintReportUriByCwd.set("/ws", { fsPath: "/ws/src/old.cj" })

			// Mock: getFixDirectiveForLearning returns a fix
			const { getFixDirectiveForLearning } = await import("../CangjieErrorAnalyzer")
			vi.mocked(getFixDirectiveForLearning).mockReturnValue("Fix the type")

			// Build succeeds (clears lastErrors, meaning old errors are "resolved")
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await (guard as any).runDebouncedPostSavePipeline("/ws")
			expect(recordLearnedFix).toHaveBeenCalledWith("/ws", "type mismatch error", "Fix the type")
		})

		it("records learned failures on failed build", async () => {
			;(guard as any).lintReportUriByCwd.set("/ws", { fsPath: "/ws/src/main.cj" })

			const incrErr: any = new Error("incr fail")
			incrErr.stdout = ""
			incrErr.stderr = "==> src/main.cj:5:1: error"
			const fullErr: any = new Error("full fail")
			fullErr.stdout = ""
			fullErr.stderr = "==> src/main.cj:5:1: error"
			// Incremental fails, then full build also fails
			mockExecFile.mockRejectedValueOnce(incrErr)
			mockExecFile.mockRejectedValueOnce(fullErr)

			await (guard as any).runDebouncedPostSavePipeline("/ws")
			expect(recordLearnedFailure).toHaveBeenCalled()
		})

		it("calls analyzeCompileOutput on failed build", async () => {
			;(guard as any).lintReportUriByCwd.set("/ws", { fsPath: "/ws/src/main.cj" })

			const incrErr: any = new Error("incr fail")
			incrErr.stdout = ""
			incrErr.stderr = "error output"
			const fullErr: any = new Error("full fail")
			fullErr.stdout = ""
			fullErr.stderr = "error output"
			mockExecFile.mockRejectedValueOnce(incrErr)
			mockExecFile.mockRejectedValueOnce(fullErr)

			await (guard as any).runDebouncedPostSavePipeline("/ws")
			expect(analyzeCompileOutput).toHaveBeenCalled()
		})

		it("reports cjlint diagnostic count when present", async () => {
			;(guard as any).lintReportUriByCwd.set("/ws", { fsPath: "/ws/src/main.cj" })
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
				{ source: "cjlint" } as any,
				{ source: "cjlint" } as any,
				{ source: "other" } as any,
			])

			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })
			await (guard as any).runDebouncedPostSavePipeline("/ws")

			expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("2 cjlint diagnostic(s)"))
		})

		it("calls onSuccessfulBuild callback when build succeeds", async () => {
			const onBuild = vi.fn()
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, undefined, onBuild)
			;(guard2 as any).lintReportUriByCwd.set("/ws", { fsPath: "/ws/src/main.cj" })

			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("toml")
			mockExecFile.mockResolvedValueOnce({ stdout: "OK", stderr: "" })

			await (guard2 as any).runDebouncedPostSavePipeline("/ws")
			expect(onBuild).toHaveBeenCalledWith({ cwd: "/ws", docUri: { fsPath: "/ws/src/main.cj" } })
		})
	})

	// ── formatDirtyCangjieFiles ──

	describe("formatDirtyCangjieFiles", () => {
		it("returns 0 when no editors are open", async () => {
			vi.mocked(vscode.window as any).visibleTextEditors = []
			const count = await guard.formatDirtyCangjieFiles()
			expect(count).toBe(0)
		})

		it("skips non-cangjie files", async () => {
			vi.mocked(vscode.window as any).visibleTextEditors = [
				{
					document: {
						languageId: "typescript",
						fileName: "test.ts",
						isDirty: true,
					},
				},
			]
			const count = await guard.formatDirtyCangjieFiles()
			expect(count).toBe(0)
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("skips clean (non-dirty) cangjie files", async () => {
			vi.mocked(vscode.window as any).visibleTextEditors = [
				{
					document: {
						languageId: "cangjie",
						fileName: "test.cj",
						isDirty: false,
					},
				},
			]
			const count = await guard.formatDirtyCangjieFiles()
			expect(count).toBe(0)
		})
	})

	// ── runCjpmTree ──

	describe("runCjpmTree", () => {
		it("returns null when cjpm not found", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue(undefined)
			const result = await guard.runCjpmTree("/ws")
			expect(result).toBeNull()
		})

		it("returns trimmed output on success", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			mockExecFile.mockResolvedValueOnce({ stdout: "  tree output  \n", stderr: "" })

			const result = await guard.runCjpmTree("/ws")
			expect(result).toBe("tree output")
		})

		it("returns null when output is empty", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			mockExecFile.mockResolvedValueOnce({ stdout: "", stderr: "" })

			const result = await guard.runCjpmTree("/ws")
			expect(result).toBeNull()
		})

		it("returns null on command failure", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			mockExecFile.mockRejectedValueOnce(new Error("command not found"))

			const result = await guard.runCjpmTree("/ws")
			expect(result).toBeNull()
		})

		it("passes correct depth argument", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			mockExecFile.mockResolvedValueOnce({ stdout: "tree", stderr: "" })

			await guard.runCjpmTree("/ws", 5)
			expect(mockExecFile).toHaveBeenCalledWith(
				"/usr/bin/cjpm",
				["tree", "-V", "--depth", "5"],
				expect.anything(),
			)
		})

		it("uses default depth of 3", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			mockExecFile.mockResolvedValueOnce({ stdout: "tree", stderr: "" })

			await guard.runCjpmTree("/ws")
			expect(mockExecFile).toHaveBeenCalledWith(
				"/usr/bin/cjpm",
				["tree", "-V", "--depth", "3"],
				expect.anything(),
			)
		})
	})

	// ── getCjpmTreeSummary ──

	describe("getCjpmTreeSummary", () => {
		it("delegates to getCjpmTreeSummaryForPrompt", async () => {
			const { getCjpmTreeSummaryForPrompt } = await import("../cjpmTreeForPrompt")
			vi.mocked(getCjpmTreeSummaryForPrompt).mockResolvedValue("summary text")

			const result = await guard.getCjpmTreeSummary("/ws")
			expect(getCjpmTreeSummaryForPrompt).toHaveBeenCalledWith("/ws")
			expect(result).toBe("summary text")
		})
	})

	// ── shouldUseIncremental (existing + additional) ──

	describe("shouldUseIncremental", () => {
		function setGuardState(state: Record<string, unknown>) {
			for (const [key, value] of Object.entries(state)) {
				;(guard as any)[key] = value
			}
		}

		it("returns false when lastFullBuildDurationMs < 5000ms", () => {
			setGuardState({ lastFullBuildDurationMs: 3000 })
			const result = (guard as any).shouldUseIncremental("/ws")
			expect(result).toBe(false)
		})

		it("returns false when incrementalAvailable is false and retry threshold not reached", () => {
			setGuardState({
				lastFullBuildDurationMs: 10000,
				incrementalAvailable: false,
				fullBuildCountSinceIncrementalFailure: 0,
			})
			const result = (guard as any).shouldUseIncremental("/ws")
			expect(result).toBe(false)
		})

		it("increments fullBuildCountSinceIncrementalFailure when incremental unavailable", () => {
			setGuardState({
				lastFullBuildDurationMs: 10000,
				incrementalAvailable: false,
				fullBuildCountSinceIncrementalFailure: 0,
			})
			;(guard as any).shouldUseIncremental("/ws")
			expect((guard as any).fullBuildCountSinceIncrementalFailure).toBe(1)
		})

		it("resets to incremental after retry threshold reached", () => {
			setGuardState({
				lastFullBuildDurationMs: 10000,
				incrementalAvailable: false,
				fullBuildCountSinceIncrementalFailure: 1,
				INCREMENTAL_RETRY_AFTER_FULL_BUILDS: 2,
			})
			;(guard as any).shouldUseIncremental("/ws")
			expect((guard as any).incrementalAvailable).toBe(true)
		})

		it("returns false when target/ directory is missing", () => {
			setGuardState({ lastFullBuildDurationMs: 10000, incrementalAvailable: true })
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const result = (guard as any).shouldUseIncremental("/ws")
			expect(result).toBe(false)
		})

		it("returns false when cjpm.toml hash changed", () => {
			setGuardState({
				lastFullBuildDurationMs: 10000,
				incrementalAvailable: true,
				lastCjpmTomlHash: "old_hash",
			})
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("new content")
			const result = (guard as any).shouldUseIncremental("/ws")
			expect(result).toBe(false)
		})

		it("returns true when all conditions are favorable", () => {
			setGuardState({
				lastFullBuildDurationMs: 10000,
				incrementalAvailable: true,
				lastCjpmTomlHash: undefined,
			})
			vi.mocked(fs.existsSync).mockReturnValue(true)
			const result = (guard as any).shouldUseIncremental("/ws")
			expect(result).toBe(true)
		})
	})

	// ── computeTomlHash ──

	describe("computeTomlHash", () => {
		it("returns undefined when cjpm.toml does not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const hash = (guard as any).computeTomlHash("/ws")
			expect(hash).toBeUndefined()
		})

		it("returns hash when cjpm.toml exists", () => {
			vi.mocked(fs.existsSync).mockImplementation((p: string) => p.includes("cjpm.toml"))
			vi.mocked(fs.readFileSync).mockReturnValue('[package]\nname = "test"')
			const hash = (guard as any).computeTomlHash("/ws")
			expect(hash).toBeDefined()
			expect(typeof hash).toBe("string")
		})

		it("caches hash for same cwd", () => {
			vi.mocked(fs.existsSync).mockImplementation((p: string) => p.includes("cjpm.toml"))
			vi.mocked(fs.readFileSync).mockReturnValue('[package]\nname = "test"')
			const hash1 = (guard as any).computeTomlHash("/ws")
			const hash2 = (guard as any).computeTomlHash("/ws")
			expect(hash1).toBe(hash2)
			expect(fs.readFileSync).toHaveBeenCalledTimes(1)
		})

		it("returns undefined on read error", () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockImplementation(() => {
				throw new Error("permission denied")
			})
			const hash = (guard as any).computeTomlHash("/ws")
			expect(hash).toBeUndefined()
		})
	})

	// ── getSuggestionForError ──

	describe("getSuggestionForError", () => {
		function getSuggestion(errorMsg: string): string | null {
			return (guard as any).getSuggestionForError(errorMsg)
		}

		it("suggests import for undeclared/cannot find errors", () => {
			const result = getSuggestion("undeclared identifier 'foo'")
			expect(result).toContain("import")
		})

		it("suggests type fix for type mismatch errors", () => {
			const result = getSuggestion("type mismatch: expected Int64, got String")
			expect(result).toContain("类型")
		})

		it("suggests let-to-var for immutable errors", () => {
			const result = getSuggestion("cannot assign to immutable variable")
			expect(result).toContain("let")
			expect(result).toContain("var")
		})

		it("suggests wildcard case for non-exhaustive match", () => {
			const result = getSuggestion("non-exhaustive match")
			expect(result).toContain("match")
		})

		it("suggests var for mut function errors", () => {
			const result = getSuggestion("mut function called on let variable")
			expect(result).toContain("let")
			expect(result).toContain("var")
		})

		it("suggests return for missing return errors", () => {
			const result = getSuggestion("missing return statement")
			expect(result).toContain("返回值")
		})

		it("suggests class for recursive struct errors", () => {
			const result = getSuggestion("recursive struct is not allowed")
			expect(result).toContain("class")
		})

		it("suggests main signature fix for main errors", () => {
			const result = getSuggestion("main function must return Int64")
			expect(result).toContain("main")
		})

		it("returns null for unrecognized errors", () => {
			const result = getSuggestion("some random error message")
			expect(result).toBeNull()
		})
	})

	// ── findCjpmRoot ──

	describe("findCjpmRoot", () => {
		it("returns undefined when no workspace folder", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
			const result = (guard as any).findCjpmRoot({ fsPath: "/ws/file.cj" })
			expect(result).toBeUndefined()
		})

		it("returns undefined when cjpm.toml does not exist in workspace", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: { fsPath: "/ws" },
			} as any)
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const result = (guard as any).findCjpmRoot({ fsPath: "/ws/file.cj" })
			expect(result).toBeUndefined()
		})

		it("returns workspace folder path when cjpm.toml exists", () => {
			vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
				uri: { fsPath: "/ws" },
			} as any)
			vi.mocked(fs.existsSync).mockReturnValue(true)
			const result = (guard as any).findCjpmRoot({ fsPath: "/ws/file.cj" })
			expect(result).toBe("/ws")
		})
	})

	// ── truncateCompileDiagnosticMessage (tested via module internals) ──

	describe("truncateCompileDiagnosticMessage", () => {
		// Access the function by calling publishCompileDiagnostics with crafted output
		// and observing the diagnostic message. The function is module-level, not exported.
		// We test it indirectly through publishCompileDiagnostics.

		it("preserves short diagnostic messages", () => {
			const mockDiagCollection = {
				set: vi.fn(),
				delete: vi.fn(),
				clear: vi.fn(),
				dispose: vi.fn(),
				[Symbol.iterator]: function* () {
					yield* []
				},
			}
			const guard2 = new CangjieCompileGuard(mockOutput, undefined, mockDiagCollection as any)
			const shortOutput = "short error"
			;(guard2 as any).publishCompileDiagnostics(
				"/ws",
				[{ file: "test.cj", line: 1, col: 1 }],
				shortOutput,
				false,
			)
			const diag = mockDiagCollection.set.mock.calls[0][1][0]
			// The message should contain the short output (truncated to 500 chars max)
			expect(diag.message).toContain("short error")
		})
	})

	// ── countCjlintDiagnostics ──

	describe("countCjlintDiagnostics", () => {
		it("returns 0 when no diagnostics exist", () => {
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
			const count = (guard as any).countCjlintDiagnostics({ fsPath: "/ws/test.cj" })
			expect(count).toBe(0)
		})

		it("counts only cjlint source diagnostics", () => {
			vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
				{ source: "cjlint" } as any,
				{ source: "cjlint" } as any,
				{ source: "cjpm" } as any,
				{ source: "other" } as any,
			])
			const count = (guard as any).countCjlintDiagnostics({ fsPath: "/ws/test.cj" })
			expect(count).toBe(2)
		})
	})

	// ── compile (queue behavior) ──

	describe("compile", () => {
		it("returns failure when cjpm not found", async () => {
			const result = await guard.compile("/ws")
			expect(result.success).toBe(false)
			expect(result.output).toContain("cjpm not found")
		})

		it("serializes compile calls for same cwd", async () => {
			vi.mocked(resolveCangjieToolPath).mockReturnValue("/usr/bin/cjpm")
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.readFileSync).mockReturnValue("toml")

			let callCount = 0
			mockExecFile.mockImplementation(() => {
				callCount++
				return Promise.resolve({ stdout: `build-${callCount}`, stderr: "" })
			})

			const r1 = await guard.compile("/ws")
			const r2 = await guard.compile("/ws")
			expect(r1.success).toBe(true)
			expect(r2.success).toBe(true)
			// Both calls should have completed sequentially
			expect(callCount).toBe(2)
		})
	})
})
