import { describe, it, expect, vi, beforeEach } from "vitest"

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
		default: { ...actual, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn() },
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn(),
	}
})

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
	Package: { resolve: vi.fn().mockReturnValue(null) },
}))

import { CangjieCompileGuard } from "../CangjieCompileGuard"

describe("CangjieCompileGuard", () => {
	let guard: CangjieCompileGuard
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		guard = new CangjieCompileGuard(mockOutput)
	})

	describe("constructor", () => {
		it("creates instance without throwing", () => {
			expect(guard).toBeDefined()
		})
	})

	describe("setMetricsCollector", () => {
		it("does not throw", () => {
			expect(() => guard.setMetricsCollector(undefined)).not.toThrow()
		})
	})

	describe("onCompile", () => {
		it("is an event", () => {
			expect(typeof guard.onCompile).toBe("function")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => guard.dispose()).not.toThrow()
		})
	})

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
			// The method checks fullBuildCountSinceIncrementalFailure >= INCREMENTAL_RETRY_AFTER_FULL_BUILDS
			// When count is 1 and threshold is 2, it increments to 2 but doesn't reset yet
			// When count is 2 and threshold is 2, it resets
			setGuardState({ fullBuildCountSinceIncrementalFailure: 1 })
			;(guard as any).shouldUseIncremental("/ws")
			// count was 1, incremented to 2, which equals threshold → resets and falls through
			expect((guard as any).incrementalAvailable).toBe(true)
		})
	})
})
