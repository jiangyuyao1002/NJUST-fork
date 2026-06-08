import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockResolveCangjieToolPath, mockExecFile, mockExistsSync, mockReaddirSync } = vi.hoisted(() => ({
	mockResolveCangjieToolPath: vi.fn(),
	mockExecFile: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReaddirSync: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		visibleTextEditors: [],
		showQuickPick: vi.fn(),
		showInformationMessage: vi.fn(),
		showTextDocument: vi.fn(),
	},
	workspace: {
		openTextDocument: vi.fn(),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	MarkdownString: class {
		constructor(public value: string) {}
	},
	OverviewRulerLane: { Right: 4 },
	OutputChannel: class {},
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveCangjieToolPath,
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, readdirSync: mockReaddirSync },
		existsSync: mockExistsSync,
		readdirSync: mockReaddirSync,
	}
})

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

import { CangjieProfiler } from "../CangjieProfiler"

describe("CangjieProfiler", () => {
	let profiler: CangjieProfiler
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		profiler = new CangjieProfiler(mockOutput)
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		mockExistsSync.mockReturnValue(false)
	})

	describe("profile", () => {
		it("returns failure when cjprof not found", async () => {
			mockResolveCangjieToolPath.mockReturnValue(undefined)
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(false)
			expect(result.output).toContain("not found")
		})

		it("returns failure when no executable found", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjprof")
			mockExistsSync.mockReturnValue(false)
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(false)
			expect(result.output).toContain("No executable found")
		})

		it("returns success with hot paths on valid profile run", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjprof")
			// Mock existsSync: true for binDir check
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["myapp"])
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") {
						cb(null, {
							stdout: '[{"function":"main","file":"main.cj","line":10,"self_time":"10ms","total_time":"100ms","percentage":80.5}]',
							stderr: "",
						})
					}
				},
			)
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(true)
			expect(result.hotPaths).toHaveLength(1)
			expect(result.hotPaths[0].functionName).toBe("main")
			expect(result.hotPaths[0].percentage).toBe(80.5)
		})

		it("parses line-based profile output", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjprof")
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["myapp"])
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") {
						cb(null, {
							stdout: "  80.5%  10ms  100ms  main (main.cj:10)\n  19.5%  2ms  20ms  helper (utils.cj:5)\n",
							stderr: "",
						})
					}
				},
			)
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(true)
			expect(result.hotPaths).toHaveLength(2)
			expect(result.hotPaths[0].functionName).toBe("main")
			expect(result.hotPaths[0].percentage).toBe(80.5)
		})

		it("returns failure on execFile error", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjprof")
			mockExistsSync.mockReturnValue(true)
			mockReaddirSync.mockReturnValue(["myapp"])
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") {
						cb(new Error("execution failed"))
					}
				},
			)
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(false)
			expect(result.output).toContain("execution failed")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => profiler.dispose()).not.toThrow()
		})
	})
})
