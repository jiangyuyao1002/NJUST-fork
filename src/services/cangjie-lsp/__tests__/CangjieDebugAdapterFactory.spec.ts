import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockExistsSync,
	mockStatSync,
	mockReaddirSync,
	mockShowErrorMessage,
	mockShowWarningMessage,
	mockShowInformationMessage,
	mockGetConfiguration,
	mockGetWorkspaceFolder,
	mockOnDidSaveTextDocument,
	mockOnDidTerminateDebugSession,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockReaddirSync: vi.fn(),
	mockShowErrorMessage: vi.fn(),
	mockShowWarningMessage: vi.fn(),
	mockShowInformationMessage: vi.fn(),
	mockGetConfiguration: vi.fn(),
	mockGetWorkspaceFolder: vi.fn(),
	mockOnDidSaveTextDocument: vi.fn(),
	mockOnDidTerminateDebugSession: vi.fn(),
}))

vi.mock("vscode", () => ({
	debug: {
		registerDebugAdapterDescriptorFactory: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		registerDebugConfigurationProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onDidTerminateDebugSession: mockOnDidTerminateDebugSession,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		getConfiguration: mockGetConfiguration,
		getWorkspaceFolder: mockGetWorkspaceFolder,
		onDidSaveTextDocument: mockOnDidSaveTextDocument,
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showErrorMessage: mockShowErrorMessage,
		showWarningMessage: mockShowWarningMessage,
		showInformationMessage: mockShowInformationMessage,
		activeTextEditor: undefined,
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	DebugAdapterExecutable: class {
		constructor(
			public command: string,
			public args: string[],
		) {}
	},
	DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: mockExistsSync,
			statSync: mockStatSync,
			readdirSync: mockReaddirSync,
		},
		existsSync: mockExistsSync,
		statSync: mockStatSync,
		readdirSync: mockReaddirSync,
	}
})

vi.mock("../cangjieToolUtils", () => ({
	detectCangjieHome: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../shared/package", () => ({
	Package: { resolve: vi.fn().mockReturnValue(null), name: "njust-ai" },
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

import * as vscode from "vscode"
import { CangjieDebugAdapterFactory, CangjieDebugConfigurationProvider } from "../CangjieDebugAdapterFactory"
import { detectCangjieHome } from "../cangjieToolUtils"

describe("CangjieDebugAdapterFactory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetConfiguration.mockReturnValue({
			get: vi.fn().mockReturnValue(false),
		})
		mockOnDidTerminateDebugSession.mockReturnValue({ dispose: vi.fn() })
		mockOnDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() })
	})

	describe("CangjieDebugConfigurationProvider", () => {
		it("is a class", () => {
			expect(typeof CangjieDebugConfigurationProvider).toBe("function")
		})

		it("provideDebugConfigurations returns 2 default configurations", () => {
			const provider = new CangjieDebugConfigurationProvider()
			const configs = provider.provideDebugConfigurations(undefined)
			expect(configs).toHaveLength(2)
			expect(configs![0]).toMatchObject({ type: "cangjie", request: "launch" })
			expect(configs![1]).toMatchObject({ type: "cangjie", request: "launch", args: ["--test"] })
		})

		it("resolveDebugConfiguration returns config when program exists on disk", () => {
			const provider = new CangjieDebugConfigurationProvider()
			mockExistsSync.mockReturnValue(true)
			const config = {
				type: "cangjie",
				request: "launch",
				name: "test",
				program: "${workspaceFolder}/target/output",
				cwd: "${workspaceFolder}",
			}
			const folder = { uri: { fsPath: "/ws" } } as any
			const result = provider.resolveDebugConfiguration(folder, config)
			expect(result).toBeDefined()
			expect((result as any).cwd).toBe("${workspaceFolder}")
		})

		it("resolveDebugConfiguration generates default config for empty config on cangjie file", () => {
			const provider = new CangjieDebugConfigurationProvider()
			// Mock activeTextEditor
			;(vscode.window as any).activeTextEditor = {
				document: { languageId: "cangjie" },
			}
			mockExistsSync.mockReturnValue(true)
			const config = {} as any
			const folder = { uri: { fsPath: "/ws" } } as any
			const result = provider.resolveDebugConfiguration(folder, config)
			expect(result).toBeDefined()
			expect(config.type).toBe("cangjie")
			expect(config.request).toBe("launch")
			// Cleanup
			;(vscode.window as any).activeTextEditor = undefined
		})

		it("resolveDebugConfiguration shows info message when no program", () => {
			const provider = new CangjieDebugConfigurationProvider()
			mockShowInformationMessage.mockResolvedValue(undefined)
			const config = { type: "cangjie", request: "launch", name: "test" } as any
			const result = provider.resolveDebugConfiguration(undefined, config)
			// Returns a Promise that resolves to undefined
			expect(result).toBeDefined()
		})
	})

	describe("CangjieDebugAdapterFactory", () => {
		it("is a class", () => {
			expect(typeof CangjieDebugAdapterFactory).toBe("function")
		})

		it("createDebugAdapterDescriptor returns undefined when cangjieHome not found", () => {
			vi.mocked(detectCangjieHome).mockReturnValue(undefined)
			const factory = new CangjieDebugAdapterFactory()
			const session = { configuration: {} } as any
			const result = factory.createDebugAdapterDescriptor(session, undefined)
			expect(result).toBeUndefined()
			expect(mockShowErrorMessage).toHaveBeenCalled()
		})

		it("createDebugAdapterDescriptor returns undefined when debugger not found", () => {
			vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
			mockExistsSync.mockReturnValue(false)
			const factory = new CangjieDebugAdapterFactory()
			const session = { configuration: {} } as any
			const result = factory.createDebugAdapterDescriptor(session, undefined)
			expect(result).toBeUndefined()
			expect(mockShowErrorMessage).toHaveBeenCalled()
		})

		it("createDebugAdapterDescriptor returns DebugAdapterExecutable when debugger found", () => {
			vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes("cjdb")) return true
				return false
			})
			const factory = new CangjieDebugAdapterFactory()
			const session = { configuration: {} } as any
			const result = factory.createDebugAdapterDescriptor(session, undefined)
			expect(result).toBeDefined()
			expect((result as any).command).toContain("cjdb")
			expect((result as any).args).toContain("--dap")
		})

		it("createDebugAdapterDescriptor filters debugger args", () => {
			vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
			mockExistsSync.mockImplementation((p: string) => {
				if (p.includes("cjdb")) return true
				return false
			})
			const factory = new CangjieDebugAdapterFactory()
			const session = {
				configuration: { debuggerArgs: ["--verbose", "bad-arg", "--port=1234"] },
			} as any
			const result = factory.createDebugAdapterDescriptor(session, undefined)
			expect(result).toBeDefined()
			// --verbose and --port=1234 are valid, "bad-arg" is filtered
			const args = (result as any).args as string[]
			expect(args).toContain("--dap")
			expect(args).toContain("--verbose")
			expect(args).toContain("--port=1234")
			expect(args).not.toContain("bad-arg")
		})

		it("dispose does not throw", () => {
			const factory = new CangjieDebugAdapterFactory()
			expect(() => factory.dispose()).not.toThrow()
		})

		it("setCompileGuard sets the compile guard", () => {
			const factory = new CangjieDebugAdapterFactory()
			const mockGuard = { compile: vi.fn() } as any
			expect(() => factory.setCompileGuard(mockGuard)).not.toThrow()
		})
	})
})
