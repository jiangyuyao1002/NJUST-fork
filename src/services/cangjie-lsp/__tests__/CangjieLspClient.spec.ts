// npx vitest run src/services/cangjie-lsp/__tests__/CangjieLspClient.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as path from "path"

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any top-level variables used in factories)
// ---------------------------------------------------------------------------

const {
	mockConfigValues,
	mockTextDocuments,
	mockWorkspaceFolders,
	mockOpenDocCallbacks,
	mockConfigChangeCallbacks,
	mockStateChangeCallbacks,
	mockClientInstances,
	mockCapturedClientOptions,
	mockCapturedServerOptions,
	mockExistsSync,
	mockReadFileSync,
	mockMkdirSync,
	mockAppendLine,
	mockShowWarningMessage,
	mockShowErrorMessage,
	mockFindFiles,
	mockExecuteCommand,
} = vi.hoisted(() => ({
	mockConfigValues: {} as Record<string, unknown>,
	mockTextDocuments: [] as Array<{
		languageId: string
		fileName: string
		uri: { fsPath: string; toString: () => string }
	}>,
	mockWorkspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
	mockOpenDocCallbacks: [] as Array<(doc: any) => void>,
	mockConfigChangeCallbacks: [] as Array<(e: any) => void>,
	mockStateChangeCallbacks: [] as Array<(e: { newState: number }) => void>,
	mockClientInstances: [] as Array<{
		start: ReturnType<typeof vi.fn>
		stop: ReturnType<typeof vi.fn>
		isRunning: ReturnType<typeof vi.fn>
		onDidChangeState: ReturnType<typeof vi.fn>
		diagnostics: {
			clear: ReturnType<typeof vi.fn>
			delete: ReturnType<typeof vi.fn>
		}
	}>,
	mockCapturedClientOptions: [] as any[],
	mockCapturedServerOptions: [] as any[],
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockAppendLine: vi.fn(),
	mockShowWarningMessage: vi.fn().mockResolvedValue(undefined),
	mockShowErrorMessage: vi.fn().mockResolvedValue(undefined),
	mockFindFiles: vi.fn().mockResolvedValue([]),
	mockExecuteCommand: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: mockAppendLine,
			dispose: vi.fn(),
		}),
		showWarningMessage: mockShowWarningMessage,
		showErrorMessage: mockShowErrorMessage,
		showInformationMessage: vi.fn().mockResolvedValue(undefined),
	},
	workspace: {
		getConfiguration: vi.fn(function () {
			return {
				get: vi.fn(function (key: string, defaultValue?: unknown) {
					return mockConfigValues[key] !== undefined ? mockConfigValues[key] : defaultValue
				}),
			}
		}),
		get textDocuments() {
			return mockTextDocuments
		},
		get workspaceFolders() {
			return mockWorkspaceFolders
		},
		onDidOpenTextDocument: vi.fn(function (cb: (doc: any) => void) {
			mockOpenDocCallbacks.push(cb)
			return { dispose: vi.fn() }
		}),
		onDidChangeConfiguration: vi.fn(function (cb: (e: any) => void) {
			mockConfigChangeCallbacks.push(cb)
			return { dispose: vi.fn() }
		}),
		createFileSystemWatcher: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		findFiles: mockFindFiles,
	},
	commands: {
		executeCommand: mockExecuteCommand,
		registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	Uri: {
		file: vi.fn(function (fsPath: string) {
			return {
				fsPath,
				toString: () => fsPath,
			}
		}),
		parse: vi.fn(),
		joinPath: vi.fn(),
	},
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
	RelativePattern: vi.fn(function (base: string, pattern: string) {
		return { base, pattern }
	}),
	CancellationError: class CancellationError extends Error {
		constructor() {
			super("Cancelled")
			this.name = "CancellationError"
		}
	},
}))

vi.mock("vscode-languageclient/node", () => ({
	LanguageClient: vi.fn(function (id, name, serverOptions, clientOptions) {
		mockCapturedServerOptions.push(serverOptions)
		mockCapturedClientOptions.push(clientOptions)
		const instance = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			isRunning: vi.fn().mockReturnValue(true),
			onDidChangeState: vi.fn(function (cb: (e: { newState: number }) => void) {
				mockStateChangeCallbacks.push(cb)
				return { dispose: vi.fn() }
			}),
			diagnostics: {
				clear: vi.fn(),
				delete: vi.fn(),
			},
		}
		mockClientInstances.push(instance)
		return instance
	}),
	TransportKind: { stdio: 0 },
}))

vi.mock("path", () => {
	const posix = require("path/posix")
	return {
		...posix,
		default: posix,
		posix,
		win32: require("path/win32"),
	}
})

vi.mock("fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
	mkdirSync: mockMkdirSync,
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("../../../shared/package", () => ({
	Package: { name: "njust-ai" },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

import * as vscode from "vscode"
import {
	CangjieLspClient,
	detectCangjieHome,
	debounceMiddleware,
	filterFalsePackageDiagnostics,
} from "../CangjieLspClient"

function resetMocks() {
	Object.keys(mockConfigValues).forEach((k) => delete mockConfigValues[k])
	mockTextDocuments.length = 0
	mockWorkspaceFolders.length = 0
	mockOpenDocCallbacks.length = 0
	mockConfigChangeCallbacks.length = 0
	mockStateChangeCallbacks.length = 0
	mockClientInstances.length = 0
	mockCapturedClientOptions.length = 0
	mockCapturedServerOptions.length = 0
	mockExistsSync.mockReset()
	mockReadFileSync.mockReset()
	mockAppendLine.mockReset()
	mockShowWarningMessage.mockReset().mockResolvedValue(undefined)
	mockShowErrorMessage.mockReset().mockResolvedValue(undefined)
	mockFindFiles.mockReset().mockResolvedValue([])
	mockExecuteCommand.mockReset().mockResolvedValue(undefined)
	vi.clearAllMocks()
}

function setupConfig(overrides: Record<string, unknown> = {}) {
	mockConfigValues["cangjieLsp.enabled"] = overrides.enabled !== undefined ? overrides.enabled : true
	mockConfigValues["cangjieLsp.serverPath"] = overrides.serverPath !== undefined ? overrides.serverPath : ""
	mockConfigValues["cangjieLsp.enableLog"] = overrides.enableLog !== undefined ? overrides.enableLog : false
	mockConfigValues["cangjieLsp.logPath"] = overrides.logPath !== undefined ? overrides.logPath : ""
	mockConfigValues["cangjieLsp.disableAutoImport"] =
		overrides.disableAutoImport !== undefined ? overrides.disableAutoImport : false
	mockConfigValues["cangjieLsp.suppressLspErrorsAfterCjpmSuccessMs"] =
		overrides.suppressLspErrorsAfterCjpmSuccessMs !== undefined ? overrides.suppressLspErrorsAfterCjpmSuccessMs : 0
}

// ---------------------------------------------------------------------------
// P0: detectCangjieHome
// ---------------------------------------------------------------------------

describe("detectCangjieHome", () => {
	const originalEnv = process.env
	const originalPlatform = process.platform

	beforeEach(() => {
		process.env = { ...originalEnv }
		delete process.env.CANGJIE_HOME
		mockExistsSync.mockReset()
		Object.defineProperty(process, "platform", { value: "linux", configurable: true, writable: true })
	})

	afterEach(() => {
		process.env = originalEnv
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true, writable: true })
	})

	it("returns CANGJIE_HOME env var when it exists", () => {
		process.env.CANGJIE_HOME = "/opt/cangjie"
		mockExistsSync.mockImplementation((p: string) => p === "/opt/cangjie")
		expect(detectCangjieHome()).toBe("/opt/cangjie")
	})

	it("falls through when CANGJIE_HOME env var does not exist", () => {
		delete process.env.CANGJIE_HOME
		mockExistsSync.mockReturnValue(false)
		expect(detectCangjieHome()).toBeUndefined()
	})

	it("falls through when CANGJIE_HOME env var points to missing path", () => {
		process.env.CANGJIE_HOME = "/missing/cangjie"
		mockExistsSync.mockReturnValue(false)
		expect(detectCangjieHome()).toBeUndefined()
	})

	it("derives home from serverPath parent when runtime dir exists", () => {
		mockExistsSync.mockImplementation((p: string) => p === "/sdk/bin/LSPServer" || p === "/sdk/runtime")
		expect(detectCangjieHome("/sdk/bin/LSPServer")).toBe("/sdk")
	})

	it("derives home from serverPath parent when lib dir exists", () => {
		mockExistsSync.mockImplementation((p: string) => p === "/sdk/bin/LSPServer" || p === "/sdk/lib")
		expect(detectCangjieHome("/sdk/bin/LSPServer")).toBe("/sdk")
	})

	it("derives home from serverPath grandparent when runtime dir exists there", () => {
		mockExistsSync.mockImplementation((p: string) => p === "/sdk/tools/bin/LSPServer" || p === "/sdk/runtime")
		expect(detectCangjieHome("/sdk/tools/bin/LSPServer")).toBe("/sdk")
	})

	it("returns undefined when serverPath does not resolve to a valid home", () => {
		mockExistsSync.mockReturnValue(false)
		expect(detectCangjieHome("/orphan/bin/LSPServer")).toBeUndefined()
	})

	it("finds well-known Linux path when bin exists", () => {
		mockExistsSync.mockImplementation((p: string) => p === "/usr/local/cangjie/bin")
		expect(detectCangjieHome()).toBe("/usr/local/cangjie")
	})

	it("finds well-known home path when bin exists", () => {
		process.env.HOME = "/home/runner"
		mockExistsSync.mockImplementation((p: string) => p === "/home/runner/.cangjie/bin")
		expect(detectCangjieHome()).toBe("/home/runner/.cangjie")
	})

	it("prefers CANGJIE_HOME over serverPath", () => {
		process.env.CANGJIE_HOME = "/env/cangjie"
		mockExistsSync.mockImplementation((p: string) => p === "/env/cangjie" || p === "/cfg/runtime")
		expect(detectCangjieHome("/cfg/bin/LSPServer")).toBe("/env/cangjie")
	})

	it("finds well-known Windows path D: when bin exists", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		// Allow all fs.existsSync calls so we can verify the returned well-known path
		mockExistsSync.mockReturnValue(true)
		const result = detectCangjieHome()
		expect(result).toBeTruthy()
		expect(result!.toLowerCase()).toContain("cangjie")
	})

	it("finds well-known Windows path C: when bin exists", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		// Sequence: false for D:\cangjie, true for C:\cangjie, false for LOCALAPPDATA
		mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValue(false)
		expect(detectCangjieHome()).toBe("C:\\cangjie")
	})

	it("finds well-known Windows LOCALAPPDATA path when bin exists", () => {
		Object.defineProperty(process, "platform", { value: "win32" })
		process.env.LOCALAPPDATA = "C:\\\\Users\\\\runner\\\\AppData\\\\Local"
		mockExistsSync.mockImplementation((p: string) => p.includes("Local/cangjie/bin"))
		expect(detectCangjieHome()).toBe("C:\\\\Users\\\\runner\\\\AppData\\\\Local/cangjie")
	})
})

// ---------------------------------------------------------------------------
// P0: Construction & state management
// ---------------------------------------------------------------------------

describe("CangjieLspClient construction & state", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
	})

	it("constructs with idle state", () => {
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		expect(client.state).toBe("idle")
		expect(client.lspOutputChannel).toBeDefined()
	})

	it("notifies state listeners on state change", () => {
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		const listener = vi.fn()
		client.onStateChange(listener)
		// Trigger a state change via start() when disabled
		mockConfigValues["cangjieLsp.enabled"] = false
		return client.start().then(() => {
			expect(listener).toHaveBeenCalledWith("stopped", undefined)
		})
	})

	it("removes state listener on dispose", () => {
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		const listener = vi.fn()
		const disposable = client.onStateChange(listener)
		disposable.dispose()
		mockConfigValues["cangjieLsp.enabled"] = false
		return client.start().then(() => {
			expect(listener).not.toHaveBeenCalled()
		})
	})

	it("fires onCangjieActivated synchronously when state is already running", async () => {
		mockExistsSync.mockReturnValue(true)
		mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } })
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("running")

		const cb = vi.fn()
		client.onCangjieActivated(cb)
		// Should be called immediately (synchronously), not deferred
		expect(cb).toHaveBeenCalledTimes(1)
	})

	it("defers onCangjieActivated until .cj file is opened when LSP disabled", async () => {
		mockConfigValues["cangjieLsp.enabled"] = false
		mockTextDocuments.length = 0
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		const cb = vi.fn()
		client.onCangjieActivated(cb)
		await client.start()
		// No .cj file open yet, callback should NOT be called
		expect(cb).not.toHaveBeenCalled()
		// Simulate opening a .cj file
		const doc = {
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		}
		mockOpenDocCallbacks.forEach((c) => c(doc))
		expect(cb).toHaveBeenCalledTimes(1)
	})
})

// ---------------------------------------------------------------------------
// P0: start() lazy-start
// ---------------------------------------------------------------------------

describe("CangjieLspClient start()", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		resetMocks()
		setupConfig()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("sets stopped when LSP is disabled", async () => {
		mockConfigValues["cangjieLsp.enabled"] = false
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("stopped")
	})

	it("defers startup when no .cj file is open", async () => {
		mockTextDocuments.length = 0
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("idle")
		expect(vscode.workspace.onDidOpenTextDocument).toHaveBeenCalled()
	})

	it("starts immediately when a .cj file is already open", async () => {
		mockExistsSync.mockReturnValue(true)
		mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } })
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("running")
	})

	it("starts on lazy trigger when user opens .cj later", async () => {
		mockExistsSync.mockReturnValue(true)
		mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } })
		mockTextDocuments.length = 0
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("idle")

		// Simulate user opening a .cj file
		const doc = {
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		}
		mockOpenDocCallbacks.forEach((cb) => cb(doc))
		// Wait for async doStart
		await vi.advanceTimersByTimeAsync(10)
		expect(client.state).toBe("running")
	})

	it("warns and sets warning state when configured serverPath does not exist", async () => {
		mockConfigValues["cangjieLsp.serverPath"] = "/missing/LSPServer"
		mockExistsSync.mockReturnValue(false)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("warning")
		expect(vscode.window.showWarningMessage).toHaveBeenCalled()
	})

	it("starts with configured serverPath when file exists", async () => {
		mockConfigValues["cangjieLsp.serverPath"] = "/custom/LSPServer"
		mockExistsSync.mockImplementation((p: string) => p === "/custom/LSPServer" || p === "/custom/runtime")
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("running")
		const lastServer = mockCapturedServerOptions[mockCapturedServerOptions.length - 1]
		expect(lastServer.command).toBe("/custom/LSPServer")
	})

	it("sets error state when client.start() throws", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		// Override the next LanguageClient instantiation to make start() reject
		const { LanguageClient: LangClient } = await import("vscode-languageclient/node")
		const mockedLangClient = vi.mocked(LangClient)
		mockedLangClient.mockImplementationOnce(function (id, name, serverOptions, clientOptions) {
			mockCapturedServerOptions.push(serverOptions)
			mockCapturedClientOptions.push(clientOptions)
			const instance = {
				start: vi.fn().mockRejectedValue(new Error("spawn failure")),
				stop: vi.fn().mockResolvedValue(undefined),
				isRunning: vi.fn().mockReturnValue(false),
				onDidChangeState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				diagnostics: { clear: vi.fn(), delete: vi.fn() },
			}
			mockClientInstances.push(instance)
			return instance as any
		})

		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("error")
	})

	it("shows localized error for initialize/system api failures", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const { LanguageClient: LangClient } = await import("vscode-languageclient/node")
		const mockedLangClient = vi.mocked(LangClient)
		mockedLangClient.mockImplementationOnce(function (id, name, serverOptions, clientOptions) {
			mockCapturedServerOptions.push(serverOptions)
			mockCapturedClientOptions.push(clientOptions)
			const instance = {
				start: vi.fn().mockRejectedValue(new Error("initialize fail")),
				stop: vi.fn().mockResolvedValue(undefined),
				isRunning: vi.fn().mockReturnValue(false),
				onDidChangeState: vi.fn().mockReturnValue({ dispose: vi.fn() }),
				diagnostics: { clear: vi.fn(), delete: vi.fn() },
			}
			mockClientInstances.push(instance)
			return instance as any
		})

		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("error")
		const lastCall = mockShowErrorMessage.mock.calls[mockShowErrorMessage.mock.calls.length - 1]
		expect(lastCall?.[0]).toContain("errors.cangjie_lsp.lsp_start_failed")
	})
})

// ---------------------------------------------------------------------------
// P0: stop() / dispose()
// ---------------------------------------------------------------------------

describe("CangjieLspClient stop() / dispose()", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
	})

	it("stop clears timers and disposes subscriptions", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		expect(client.state).toBe("running")
		await client.stop()
		expect(client.state).toBe("stopped")
	})

	it("stop stops the running client", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const instance = mockClientInstances[mockClientInstances.length - 1]
		await client.stop()
		expect(instance.stop).toHaveBeenCalled()
	})

	it("dispose forces stop after 5s timeout when client.stop() hangs", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		vi.useFakeTimers()
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const instance = mockClientInstances[mockClientInstances.length - 1]
		// Make stop() never resolve
		instance.stop.mockImplementation(() => new Promise(() => {}))

		const disposePromise = client.dispose()
		// Should not resolve before timeout
		vi.advanceTimersByTime(4999)
		await Promise.resolve()
		let resolved = false
		void disposePromise.then(() => {
			resolved = true
		})
		await Promise.resolve()
		expect(resolved).toBe(false)

		// After 5s timeout, should resolve
		vi.advanceTimersByTime(2)
		await disposePromise
		expect(resolved).toBe(true)
		vi.useRealTimers()
	})

	it("restart resets auto-restart count and restarts", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		// Manually bump restart count
		;(client as any).autoRestartCount = 2
		await client.restart()
		expect(client.state).toBe("running")
		expect((client as any).autoRestartCount).toBe(0)
	})
})

// ---------------------------------------------------------------------------
// P1: scheduleAutoRestart
// ---------------------------------------------------------------------------

describe("CangjieLspClient scheduleAutoRestart", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("schedules restart with increasing delays (2s -> 5s -> 10s) when crashes are consecutive", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const extAppendLine = vi.fn()
		const client = new CangjieLspClient({ appendLine: extAppendLine } as any)
		await client.start()
		expect(client.state).toBe("running")

		// Crash 3 times in a row; after each restart succeeds, count resets.
		// To test increasing delays, we need to prevent successful restart.
		// Override the next LanguageClient instantiation to make start() fail.
		const { LanguageClient: LangClient } = await import("vscode-languageclient/node")
		const mockedLangClient = vi.mocked(LangClient)
		const originalImpl = mockedLangClient.getMockImplementation()
		mockedLangClient.mockImplementation(function (id, name, serverOptions, clientOptions) {
			mockCapturedServerOptions.push(serverOptions)
			mockCapturedClientOptions.push(clientOptions)
			const instance = {
				start: vi.fn().mockRejectedValue(new Error("spawn failure")),
				stop: vi.fn().mockResolvedValue(undefined),
				isRunning: vi.fn().mockReturnValue(false),
				onDidChangeState: vi.fn(function (cb: (e: { newState: number }) => void) {
					mockStateChangeCallbacks.push(cb)
					return { dispose: vi.fn() }
				}),
				diagnostics: { clear: vi.fn(), delete: vi.fn() },
			}
			mockClientInstances.push(instance)
			return instance as any
		})

		// Manually schedule restarts (doStart will fail, count won't reset)
		;(client as any).autoRestartCount = 0
		;(client as any).scheduleAutoRestart()
		expect(extAppendLine).toHaveBeenCalledWith(expect.stringContaining("Auto-restarting in 2s"))
		await vi.advanceTimersByTimeAsync(3000)
		;(client as any).scheduleAutoRestart()
		expect(extAppendLine).toHaveBeenCalledWith(expect.stringContaining("Auto-restarting in 5s"))
		await vi.advanceTimersByTimeAsync(6000)
		;(client as any).scheduleAutoRestart()
		expect(extAppendLine).toHaveBeenCalledWith(expect.stringContaining("Auto-restarting in 10s"))
		await vi.advanceTimersByTimeAsync(11000)

		// Restore original mock so subsequent tests aren't affected
		mockedLangClient.mockImplementation(originalImpl ?? (() => ({}) as any))
	})

	it("stops auto-restarting after max attempts and shows manual restart button", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()

		// Set count to max so next crash triggers the limit message
		;(client as any).autoRestartCount = 3

		// Trigger crash
		const cb = mockStateChangeCallbacks[mockStateChangeCallbacks.length - 1]
		cb({ newState: 1 })

		expect(mockShowErrorMessage).toHaveBeenCalledWith(
			expect.stringContaining("errors.cangjie_lsp.lsp_crashed_repeatedly"),
			expect.stringContaining("buttons.cangjie_lsp.manual_restart"),
		)
	})

	it("manual restart resets counter and restarts", async () => {
		mockShowErrorMessage.mockResolvedValueOnce("buttons.cangjie_lsp.manual_restart")
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()

		// Set count to max to trigger the manual prompt
		;(client as any).autoRestartCount = 3

		// Trigger crash
		const cb = mockStateChangeCallbacks[mockStateChangeCallbacks.length - 1]
		cb({ newState: 1 })

		// Wait for showErrorMessage promise
		await Promise.resolve()
		await Promise.resolve()

		expect((client as any).autoRestartCount).toBe(0)
	})

	it("stop cancels pending restart timer", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()

		const cb = mockStateChangeCallbacks[mockStateChangeCallbacks.length - 1]
		cb({ newState: 1 })
		expect((client as any).restartTimer).toBeDefined()

		await client.stop()
		expect((client as any).restartTimer).toBeUndefined()
	})
})

// ---------------------------------------------------------------------------
// P1: Configuration change handling
// ---------------------------------------------------------------------------

describe("CangjieLspClient configuration changes", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
	})

	it("ignores config changes unrelated to cangjieLsp", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const startCount = mockClientInstances.length

		// Trigger config change for unrelated key
		const event = { affectsConfiguration: (key: string) => !key.includes("cangjieLsp") }
		mockConfigChangeCallbacks.forEach((cb) => cb(event))
		await Promise.resolve()
		await Promise.resolve()

		expect(mockClientInstances.length).toBe(startCount)
	})

	it("restarts server on cangjieLsp config change", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const startCount = mockClientInstances.length

		// Trigger config change
		const event = { affectsConfiguration: (key: string) => key.includes("cangjieLsp") }
		mockConfigChangeCallbacks.forEach((cb) => cb(event))
		// Wait for the internal restart chain to complete
		await (client as any).configRestartChain

		// Should have stopped old and started new
		expect(mockClientInstances.length).toBeGreaterThan(startCount)
	})

	it("serializes rapid config changes so they do not overlap", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const startCount = mockClientInstances.length

		// Fire 3 rapid config changes
		const event = { affectsConfiguration: (key: string) => key.includes("cangjieLsp") }
		mockConfigChangeCallbacks.forEach((cb) => cb(event))
		mockConfigChangeCallbacks.forEach((cb) => cb(event))
		mockConfigChangeCallbacks.forEach((cb) => cb(event))

		// Wait for the chain to settle
		await (client as any).configRestartChain

		// Should have 3 more instances (one per restart), not 6 (overlapping)
		expect(mockClientInstances.length).toBe(startCount + 3)
	})
})

// ---------------------------------------------------------------------------
// P2: markCjpmBuildSuccess + diagnostics
// ---------------------------------------------------------------------------

describe("CangjieLspClient cjpm build success & diagnostics", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
	})

	it("records build success timestamp", () => {
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		const before = Date.now()
		client.markCjpmBuildSuccess("/proj")
		const after = Date.now()
		const map = (client as any).lastCjpmSuccessAtMsByCwd
		const key = path.normalize("/proj")
		const ts = map.get(key)
		expect(ts).toBeGreaterThanOrEqual(before)
		expect(ts).toBeLessThanOrEqual(after)
	})

	it("ignores empty cwd in markCjpmBuildSuccess", () => {
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		client.markCjpmBuildSuccess("")
		const map = (client as any).lastCjpmSuccessAtMsByCwd
		expect(map.size).toBe(0)
	})

	it("clears all diagnostics when no cwd specified", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const instance = mockClientInstances[mockClientInstances.length - 1]
		client.clearPublishedDiagnostics()
		expect(instance.diagnostics.clear).toHaveBeenCalled()
	})

	it("clears diagnostics only under specified cwd", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push(
			{
				languageId: "cangjie",
				fileName: "/proj-a/main.cj",
				uri: { fsPath: "/proj-a/main.cj", toString: () => "/proj-a/main.cj" },
			},
			{
				languageId: "cangjie",
				fileName: "/proj-b/main.cj",
				uri: { fsPath: "/proj-b/main.cj", toString: () => "/proj-b/main.cj" },
			},
		)
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const instance = mockClientInstances[mockClientInstances.length - 1]
		client.clearPublishedDiagnostics({ cwd: "/proj-a" })
		expect(instance.diagnostics.delete).toHaveBeenCalledTimes(1)
	})

	it("clearPublishedDiagnostics is no-op when no LSP client is active", async () => {
		mockConfigValues["cangjieLsp.enabled"] = false
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		// Verify no diagnostics collection is touched
		expect(mockClientInstances.length).toBe(0)
		expect(() => client.clearPublishedDiagnostics()).not.toThrow()
		expect(mockClientInstances.length).toBe(0)
	})

	it("middleware suppresses stale LSP errors after cjpm success", async () => {
		mockExistsSync.mockReturnValue(true)
		mockReadFileSync.mockReturnValue('[package]\nname = "demo"')
		mockWorkspaceFolders.push({ uri: { fsPath: "/proj" } })
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "/proj/main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
		})
		mockConfigValues["cangjieLsp.enableLog"] = true
		mockConfigValues["cangjieLsp.suppressLspErrorsAfterCjpmSuccessMs"] = 5000
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const clientOptions = mockCapturedClientOptions[mockCapturedClientOptions.length - 1]
		expect(clientOptions.middleware).toBeDefined()

		client.markCjpmBuildSuccess("/proj")
		const uri = { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" } as vscode.Uri
		const next = vi.fn()
		const diagnostics = [
			{ severity: vscode.DiagnosticSeverity.Error, message: "err1" } as vscode.Diagnostic,
			{ severity: vscode.DiagnosticSeverity.Warning, message: "warn1" } as vscode.Diagnostic,
		]

		clientOptions.middleware.handleDiagnostics(uri, diagnostics, next)
		expect(next).toHaveBeenCalled()
		const passed = next.mock.calls[0][1] as vscode.Diagnostic[]
		// Error should be suppressed, warning kept
		expect(passed.length).toBe(1)
		expect(passed[0].severity).toBe(vscode.DiagnosticSeverity.Warning)
	})
})

// ---------------------------------------------------------------------------
// P2: filterFalsePackageDiagnostics
// ---------------------------------------------------------------------------

describe("filterFalsePackageDiagnostics", () => {
	it("passes through diagnostics that do not mention package name", () => {
		const diagnostics = [
			{ message: "syntax error", severity: 0 } as vscode.Diagnostic,
			{ message: "type mismatch", severity: 0 } as vscode.Diagnostic,
		]
		const result = filterFalsePackageDiagnostics(diagnostics, "demo", {
			fsPath: "/proj/main.cj",
			toString: () => "/proj/main.cj",
		} as vscode.Uri)
		expect(result).toHaveLength(2)
	})

	it("filters when real package is not default but LSP expects default", () => {
		const diagnostics = [{ message: "package name supposed to be 'default'", severity: 0 } as vscode.Diagnostic]
		const result = filterFalsePackageDiagnostics(diagnostics, "myPkg", {
			fsPath: "/proj/main.cj",
			toString: () => "/proj/main.cj",
		} as vscode.Uri)
		expect(result).toHaveLength(0)
	})

	it("filters when document already declares the exact package LSP expects", () => {
		mockTextDocuments.length = 0
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "/proj/main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
			getText: () => "package expectedPkg\n",
		} as any)

		const diagnostics = [{ message: "package name supposed to be 'expectedPkg'", severity: 0 } as vscode.Diagnostic]
		const result = filterFalsePackageDiagnostics(diagnostics, undefined, {
			fsPath: "/proj/main.cj",
			toString: () => "/proj/main.cj",
		} as vscode.Uri)
		expect(result).toHaveLength(0)
	})

	it("filters when LSP expects default but document has explicit package", () => {
		mockTextDocuments.length = 0
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "/proj/main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
			getText: () => "package myPkg\n",
		} as any)

		const diagnostics = [{ message: "package name supposed to be 'default'", severity: 0 } as vscode.Diagnostic]
		const result = filterFalsePackageDiagnostics(diagnostics, "myPkg", {
			fsPath: "/proj/main.cj",
			toString: () => "/proj/main.cj",
		} as vscode.Uri)
		expect(result).toHaveLength(0)
	})

	it("keeps diagnostic when document does not match LSP expectation", () => {
		mockTextDocuments.length = 0
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "/proj/main.cj",
			uri: { fsPath: "/proj/main.cj", toString: () => "/proj/main.cj" },
			getText: () => "package otherPkg\n",
		} as any)

		const diagnostics = [{ message: "package name supposed to be 'expectedPkg'", severity: 0 } as vscode.Diagnostic]
		const result = filterFalsePackageDiagnostics(diagnostics, undefined, {
			fsPath: "/proj/main.cj",
			toString: () => "/proj/main.cj",
		} as vscode.Uri)
		expect(result).toHaveLength(1)
	})
})

// ---------------------------------------------------------------------------
// P2: Windows platform behavior
// ---------------------------------------------------------------------------

describe("CangjieLspClient Windows platform", () => {
	beforeEach(() => {
		resetMocks()
		setupConfig()
		Object.defineProperty(process, "platform", { value: "win32" })
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: "win32" })
	})

	it("resolves LSPServer.exe on Windows", async () => {
		mockExistsSync.mockReturnValue(true)
		mockTextDocuments.push({
			languageId: "cangjie",
			fileName: "main.cj",
			uri: { fsPath: "C:\\\\proj\\\\main.cj", toString: () => "C:\\\\proj\\\\main.cj" },
		})
		const client = new CangjieLspClient({ appendLine: vi.fn() } as any)
		await client.start()
		const lastServer = mockCapturedServerOptions[mockCapturedServerOptions.length - 1]
		expect(lastServer.command).toMatch(/LSPServer\.exe$/)
	})
})

// ---------------------------------------------------------------------------
// Existing debounceMiddleware tests
// ---------------------------------------------------------------------------

describe("debounceMiddleware", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("should reject old request with CancellationError when new request arrives", async () => {
		const middleware = debounceMiddleware<string>(100)

		let callCount = 0
		const nextFactory = () => {
			const n = ++callCount
			return () => `result-${n}` as unknown as vscode.ProviderResult<string>
		}

		// First request
		const firstPromise = middleware(nextFactory())

		// Before the timer fires, send a second request (cancels the first)
		const secondPromise = middleware(nextFactory())

		// Advance timer to trigger the second request's callback
		vi.advanceTimersByTime(150)

		// Second request should resolve with fresh data
		await expect(secondPromise).resolves.toBe("result-2")

		// First request should be rejected with CancellationError, not resolved with stale data
		await expect(firstPromise).rejects.toThrow("Cancelled")
	})

	it("should resolve with fresh data when only one request is made", async () => {
		const middleware = debounceMiddleware<string>(100)

		const firstPromise = middleware(() => "fresh-result" as unknown as vscode.ProviderResult<string>)

		vi.advanceTimersByTime(150)

		await expect(firstPromise).resolves.toBe("fresh-result")
	})
})
