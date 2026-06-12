import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockCreateStatusBarItem,
	mockRegisterCommand,
	mockOnDidChangeActiveTextEditor,
	mockShow,
	mockHide,
	mockDispose,
	mockResolveCangjieToolPath,
	mockExecFile,
} = vi.hoisted(() => ({
	mockCreateStatusBarItem: vi.fn(),
	mockRegisterCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	mockOnDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	mockShow: vi.fn(),
	mockHide: vi.fn(),
	mockDispose: vi.fn(),
	mockResolveCangjieToolPath: vi.fn(),
	mockExecFile: vi.fn(),
}))

let currentActiveEditor: any = undefined

vi.mock("vscode", () => ({
	window: {
		createStatusBarItem: mockCreateStatusBarItem,
		onDidChangeActiveTextEditor: mockOnDidChangeActiveTextEditor,
		get activeTextEditor() {
			return currentActiveEditor
		},
	},
	commands: {
		registerCommand: mockRegisterCommand,
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
	OutputChannel: class {},
}))

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("util", () => ({
	promisify:
		(fn: (...args: any[]) => any) =>
		(...args: any[]) =>
			fn(...args),
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveCangjieToolPath,
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	CJC_CONFIG_KEY: "cangjieTools.cjcPath",
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, unknown>) => {
		if (params) return `${key}(${JSON.stringify(params)})`
		return key
	},
}))

import { CangjieLspStatusBar } from "../CangjieLspStatusBar"

describe("CangjieLspStatusBar", () => {
	let mockLspClient: any
	let mockLspOutput: any
	let mockBuildOutput: any
	let lspItem: any
	let compileItem: any
	let stateChangeCallback: (state: string, message?: string) => void

	beforeEach(() => {
		vi.clearAllMocks()
		currentActiveEditor = undefined
		lspItem = {
			text: "",
			tooltip: "",
			backgroundColor: undefined,
			command: "",
			show: mockShow,
			hide: mockHide,
			dispose: mockDispose,
		}
		compileItem = {
			text: "",
			tooltip: "",
			backgroundColor: undefined,
			command: "",
			show: mockShow,
			hide: mockHide,
			dispose: mockDispose,
		}
		mockCreateStatusBarItem.mockReturnValueOnce(lspItem).mockReturnValueOnce(compileItem)
		stateChangeCallback = () => {}
		mockLspClient = {
			state: "idle",
			onStateChange: vi.fn((cb: any) => {
				stateChangeCallback = cb
				return { dispose: vi.fn() }
			}),
		}
		mockLspOutput = { show: vi.fn(), dispose: vi.fn() }
		mockBuildOutput = { show: vi.fn(), dispose: vi.fn() }
		mockResolveCangjieToolPath.mockReturnValue(undefined)
	})

	// ── constructor ──────────────────────────────────────────────────

	describe("constructor", () => {
		it("creates two status bar items with correct alignment", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(mockCreateStatusBarItem).toHaveBeenCalledTimes(2)
			expect(mockCreateStatusBarItem).toHaveBeenNthCalledWith(1, 1, 50)
			expect(mockCreateStatusBarItem).toHaveBeenNthCalledWith(2, 1, 49)
			sb.dispose()
		})

		it("sets LSP command on lspItem", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(lspItem.command).toBe("njust-ai.cangjieShowLspOutput")
			sb.dispose()
		})

		it("sets compile command on compileItem", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(compileItem.command).toBe("njust-ai.cangjieShowCompileOutput")
			sb.dispose()
		})

		it("registers both output commands", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(mockRegisterCommand).toHaveBeenCalledWith("njust-ai.cangjieShowLspOutput", expect.any(Function))
			expect(mockRegisterCommand).toHaveBeenCalledWith("njust-ai.cangjieShowCompileOutput", expect.any(Function))
			sb.dispose()
		})

		it("subscribes to LSP state changes", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(mockLspClient.onStateChange).toHaveBeenCalled()
			sb.dispose()
		})

		it("subscribes to active editor changes", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(mockOnDidChangeActiveTextEditor).toHaveBeenCalledWith(expect.any(Function))
			sb.dispose()
		})

		it("initializes LSP state from client", () => {
			mockLspClient.state = "running"
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(lspItem.text).toContain("check")
			sb.dispose()
		})

		it("sets compile idle text on init", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(compileItem.text).toContain("compile_idle")
			sb.dispose()
		})
	})

	// ── detectSdkVersion ────────────────────────────────────────────

	describe("detectSdkVersion", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("sets sdkVersion when cjc --version succeeds", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/usr/bin/cjc")
			mockExecFile.mockResolvedValueOnce({ stdout: "cjc 1.5.0\n", stderr: "" })
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			await vi.waitFor(() => {
				expect((sb as any).sdkVersion).toBe("cjc 1.5.0")
			})
			sb.dispose()
		})

		it("updates lspItem text after detecting version in running state", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/usr/bin/cjc")
			mockExecFile.mockResolvedValueOnce({ stdout: "cjc 2.0.0\n", stderr: "" })
			mockLspClient.state = "running"
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			await vi.waitFor(() => {
				expect(lspItem.text).toContain("cjc 2.0.0")
			})
			sb.dispose()
		})

		it("returns early when cjcPath is undefined", async () => {
			mockResolveCangjieToolPath.mockReturnValue(undefined)
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			await vi.advanceTimersByTimeAsync(50)
			expect((sb as any).sdkVersion).toBeUndefined()
			expect(mockExecFile).not.toHaveBeenCalled()
			sb.dispose()
		})

		it("catches exec error silently", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/usr/bin/cjc")
			mockExecFile.mockRejectedValueOnce(new Error("timeout"))
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			await vi.advanceTimersByTimeAsync(50)
			expect((sb as any).sdkVersion).toBeUndefined()
			sb.dispose()
		})

		it("handles multi-line stdout, takes first line", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/usr/bin/cjc")
			mockExecFile.mockResolvedValueOnce({ stdout: "cjc 3.0.0\nextra info\n", stderr: "" })
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			await vi.waitFor(() => {
				expect((sb as any).sdkVersion).toBe("cjc 3.0.0")
			})
			sb.dispose()
		})
	})

	// ── updateLspState ───────────────────────────────────────────────

	describe("updateLspState", () => {
		it("idle: sets text and tooltip, no background", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("idle")
			expect(lspItem.text).toBe("$(circle-outline) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_idle")
			expect(lspItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("starting: sets spinner text", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("starting")
			expect(lspItem.text).toBe("$(sync~spin) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_starting")
			expect(lspItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("running without sdk: shows generic text", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("running")
			expect(lspItem.text).toBe("$(check) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_running")
			expect(lspItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("running with sdk: shows version in text", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).sdkVersion = "v1.0"
			;(sb as any).updateLspState("running")
			expect(lspItem.text).toBe("$(check) Cangjie v1.0")
			expect(lspItem.tooltip).toContain("v1.0")
			sb.dispose()
		})

		it("warning with message: shows warning tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("warning", "high memory")
			expect(lspItem.text).toBe("$(warning) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_warning")
			expect(lspItem.tooltip).toContain("high memory")
			expect(lspItem.backgroundColor).toBeDefined()
			expect(lspItem.backgroundColor.id).toBe("statusBarItem.warningBackground")
			sb.dispose()
		})

		it("warning without message: shows abnormal tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("warning")
			expect(lspItem.tooltip).toContain("lsp_abnormal")
			expect(lspItem.backgroundColor).toBeDefined()
			sb.dispose()
		})

		it("error with message: shows error tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("error", "connection lost")
			expect(lspItem.text).toBe("$(error) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_error")
			expect(lspItem.tooltip).toContain("connection lost")
			expect(lspItem.backgroundColor).toBeDefined()
			expect(lspItem.backgroundColor.id).toBe("statusBarItem.errorBackground")
			sb.dispose()
		})

		it("error without message: shows start_failed tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("error")
			expect(lspItem.tooltip).toContain("lsp_start_failed")
			expect(lspItem.backgroundColor).toBeDefined()
			sb.dispose()
		})

		it("stopped: sets circle-slash text", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("stopped")
			expect(lspItem.text).toBe("$(circle-slash) Cangjie LSP")
			expect(lspItem.tooltip).toContain("lsp_stopped")
			expect(lspItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("includes version suffix when sdkVersion is set", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).sdkVersion = "v2.0"
			;(sb as any).updateLspState("idle")
			expect(lspItem.tooltip).toContain("v2.0")
			sb.dispose()
		})

		it("stores lastState and lastMessage for re-call", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateLspState("warning", "oops")
			expect((sb as any)._lastState).toBe("warning")
			expect((sb as any)._lastMessage).toBe("oops")
			sb.dispose()
		})

		it("can be triggered via onStateChange callback", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			stateChangeCallback("error", "crash")
			expect(lspItem.text).toBe("$(error) Cangjie LSP")
			expect(lspItem.tooltip).toContain("crash")
			sb.dispose()
		})
	})

	// ── attachCompileGuard ──────────────────────────────────────────

	describe("attachCompileGuard", () => {
		let compileCallback: (ev: any) => void
		let mockGuard: any

		beforeEach(() => {
			compileCallback = () => {}
			mockGuard = {
				onCompile: vi.fn((cb: any) => {
					compileCallback = cb
					return { dispose: vi.fn() }
				}),
			}
		})

		it("subscribes to compile events", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			statusBar_attach(sb, mockGuard)
			expect(mockGuard.onCompile).toHaveBeenCalled()
			sb.dispose()
		})

		it("disposes previous subscription when re-attaching", () => {
			const disposeFn1 = vi.fn()
			const guard1 = { onCompile: vi.fn().mockReturnValue({ dispose: disposeFn1 }) }
			const guard2 = { onCompile: vi.fn().mockReturnValue({ dispose: vi.fn() }) }
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(guard1 as any)
			sb.attachCompileGuard(guard2 as any)
			expect(disposeFn1).toHaveBeenCalled()
			sb.dispose()
		})

		it("start event: sets busy spinner and tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({ status: "start" })
			expect(compileItem.text).toContain("sync~spin")
			expect(compileItem.text).toContain("compile_compiling")
			expect(compileItem.tooltip).toBe("tooltips.cangjie_lsp.compile_in_progress")
			expect(compileItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("success (full build): shows time and full label", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({ status: "start" })
			compileCallback({ status: "end", success: true, durationMs: 3500, incremental: false })
			expect(compileItem.text).toContain("check")
			expect(compileItem.text).toContain("3.5")
			expect(compileItem.text).toContain("full")
			expect(compileItem.backgroundColor).toBeUndefined()
			sb.dispose()
		})

		it("success (incremental): shows time and incremental label", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({ status: "end", success: true, durationMs: 1200, incremental: true })
			expect(compileItem.text).toContain("1.2")
			expect(compileItem.text).toContain("incremental")
			sb.dispose()
		})

		it("success incremental with savings: tooltip includes savings info", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({
				status: "end",
				success: true,
				durationMs: 1000,
				incremental: true,
				lastFullBuildMs: 5000,
			})
			expect(compileItem.tooltip).toContain("incremental_savings")
			expect(compileItem.tooltip).toContain("5.0")
			expect(compileItem.tooltip).toContain("80")
			sb.dispose()
		})

		it("success incremental without savings info: no savings in tooltip", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({
				status: "end",
				success: true,
				durationMs: 1000,
				incremental: true,
			})
			expect(compileItem.tooltip).not.toContain("incremental_savings")
			sb.dispose()
		})

		it("success with null durationMs: shows ? for time", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({
				status: "end",
				success: true,
				durationMs: null,
				incremental: false,
			})
			expect(compileItem.text).toContain("?")
			sb.dispose()
		})

		it("failure: shows error count and error background", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({
				status: "end",
				success: false,
				durationMs: 2000,
				errorCount: 3,
			})
			expect(compileItem.text).toContain("error")
			expect(compileItem.text).toContain("3 errors")
			expect(compileItem.text).toContain("2.0")
			expect(compileItem.tooltip).toBe("tooltips.cangjie_lsp.compile_failed")
			expect(compileItem.backgroundColor).toBeDefined()
			expect(compileItem.backgroundColor.id).toBe("statusBarItem.errorBackground")
			sb.dispose()
		})

		it("failure with 1 error: singular form", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({
				status: "end",
				success: false,
				durationMs: 1000,
				errorCount: 1,
			})
			expect(compileItem.text).toContain("1 error")
			expect(compileItem.text).not.toContain("errors")
			sb.dispose()
		})

		it("failure with null errorCount: defaults to 0", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({ status: "end", success: false, durationMs: 1000 })
			expect(compileItem.text).toContain("0 errors")
			sb.dispose()
		})

		it("sets compilePhase to idle after end event", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard)
			compileCallback({ status: "start" })
			expect((sb as any).compilePhase).toBe("busy")
			compileCallback({ status: "end", success: true, durationMs: 100, incremental: false })
			expect((sb as any).compilePhase).toBe("idle")
			sb.dispose()
		})
	})

	// ── updateVisibility ────────────────────────────────────────────

	describe("updateVisibility", () => {
		it("shows both items for cangjie language editor", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateVisibility({ document: { languageId: "cangjie", fileName: "test.cj" } })
			expect(mockShow).toHaveBeenCalled()
			sb.dispose()
		})

		it("shows both items for .cj file extension", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateVisibility({ document: { languageId: "plaintext", fileName: "main.cj" } })
			expect(mockShow).toHaveBeenCalled()
			sb.dispose()
		})

		it("hides both items for non-cangjie editor", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).updateVisibility({ document: { languageId: "typescript", fileName: "app.ts" } })
			expect(mockHide).toHaveBeenCalled()
			sb.dispose()
		})

		it("hides both items when editor is undefined", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			mockShow.mockClear()
			;(sb as any).updateVisibility(undefined)
			expect(mockHide).toHaveBeenCalled()
			sb.dispose()
		})

		it("keeps compile visible when busy and editor is non-cangjie", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).compilePhase = "busy"
			mockShow.mockClear()
			mockHide.mockClear()
			;(sb as any).updateVisibility({ document: { languageId: "typescript", fileName: "app.ts" } })
			expect(mockShow).toHaveBeenCalled()
			sb.dispose()
		})

		it("hides compile when idle and editor is non-cangjie", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			;(sb as any).compilePhase = "idle"
			mockHide.mockClear()
			;(sb as any).updateVisibility({ document: { languageId: "typescript", fileName: "app.ts" } })
			expect(mockHide).toHaveBeenCalled()
			sb.dispose()
		})
	})

	// ── registered commands ─────────────────────────────────────────

	describe("registered commands", () => {
		it("LSP command shows lsp output channel", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			const lspCmd = mockRegisterCommand.mock.calls.find((c: any[]) => c[0] === "njust-ai.cangjieShowLspOutput")
			expect(lspCmd).toBeDefined()
			lspCmd![1]()
			expect(mockLspOutput.show).toHaveBeenCalledWith(true)
			sb.dispose()
		})

		it("compile command shows build output channel", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			const compileCmd = mockRegisterCommand.mock.calls.find(
				(c: any[]) => c[0] === "njust-ai.cangjieShowCompileOutput",
			)
			expect(compileCmd).toBeDefined()
			compileCmd![1]()
			expect(mockBuildOutput.show).toHaveBeenCalledWith(true)
			sb.dispose()
		})
	})

	// ── dispose ─────────────────────────────────────────────────────

	describe("dispose", () => {
		it("disposes both status bar items", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.dispose()
			expect(mockDispose).toHaveBeenCalled()
		})

		it("disposes compile guard subscription when attached", () => {
			const guardDispose = vi.fn()
			const mockGuard = { onCompile: vi.fn().mockReturnValue({ dispose: guardDispose }) }
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			sb.attachCompileGuard(mockGuard as any)
			sb.dispose()
			expect(guardDispose).toHaveBeenCalled()
		})

		it("does not throw without compile guard", () => {
			const sb = new CangjieLspStatusBar(mockLspClient, mockLspOutput, mockBuildOutput)
			expect(() => sb.dispose()).not.toThrow()
		})
	})
})

// helper to avoid unused variable warning
function statusBar_attach(sb: CangjieLspStatusBar, guard: any) {
	sb.attachCompileGuard(guard)
}
