import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockExistsSync,
	mockRegisterCommand,
	mockShowErrorMessage,
	mockShowInformationMessage,
	mockShowWarningMessage,
	mockShowQuickPick,
	mockShowInputBox,
	mockShowTextDocument,
	mockCreateTerminal,
	mockCreateOutputChannel,
	mockGetWorkspaceFolder,
	mockOpenTextDocument,
	mockOnDidSaveTextDocument,
	mockCreateTextEditorDecorationType,
	mockExecuteCommand,
	mockResolveCangjieToolPath,
	mockBuildCangjieToolEnv,
	mockFormatCangjieToolchainReport,
	mockProbeCangjieToolchain,
	mockWriteFileSync,
	mockMkdirSync,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockRegisterCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	mockShowErrorMessage: vi.fn(),
	mockShowInformationMessage: vi.fn(),
	mockShowWarningMessage: vi.fn(),
	mockShowQuickPick: vi.fn(),
	mockShowInputBox: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockCreateTerminal: vi.fn(),
	mockCreateOutputChannel: vi.fn(),
	mockGetWorkspaceFolder: vi.fn(),
	mockOpenTextDocument: vi.fn(),
	mockOnDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	mockCreateTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	mockExecuteCommand: vi.fn(),
	mockResolveCangjieToolPath: vi.fn(),
	mockBuildCangjieToolEnv: vi.fn().mockReturnValue({}),
	mockFormatCangjieToolchainReport: vi.fn().mockReturnValue("report"),
	mockProbeCangjieToolchain: vi.fn().mockResolvedValue([]),
	mockWriteFileSync: vi.fn(),
	mockMkdirSync: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: mockCreateOutputChannel,
		showQuickPick: mockShowQuickPick,
		showInputBox: mockShowInputBox,
		showInformationMessage: mockShowInformationMessage,
		showWarningMessage: mockShowWarningMessage,
		showErrorMessage: mockShowErrorMessage,
		showOpenDialog: vi.fn(),
		showTextDocument: mockShowTextDocument,
		activeTextEditor: undefined,
		createTextEditorDecorationType: mockCreateTextEditorDecorationType,
		createTerminal: mockCreateTerminal,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: mockOpenTextDocument,
		onDidSaveTextDocument: mockOnDidSaveTextDocument,
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
		getWorkspaceFolder: mockGetWorkspaceFolder,
	},
	commands: {
		registerCommand: mockRegisterCommand,
		executeCommand: mockExecuteCommand,
	},
	languages: {
		registerCodeActionsProvider: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
		parse: (s: string) => ({ fsPath: s, toString: () => s }),
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
	Selection: class {
		constructor(
			public anchor: unknown,
			public active: unknown,
		) {}
	},
	WorkspaceEdit: class {
		set() {}
		replace() {}
		insert() {}
		delete() {}
	},
	Location: class {
		constructor(
			public uri: unknown,
			public range: unknown,
		) {}
	},
	CodeAction: class {
		constructor(
			public title: string,
			public kind: unknown,
		) {}
	},
	CodeActionKind: {
		RefactorExtract: { value: "refactor.extract" },
		Refactor: { value: "refactor" },
	},
	OverviewRulerLane: { Right: 4 },
	SnippetString: class {
		constructor(public value: string) {}
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
	TaskGroup: { Build: "build", Test: "test", Clean: "clean" },
	TaskRevealKind: { Always: 2 },
	TaskPanelKind: { Shared: 2 },
	ShellExecution: class {
		constructor(
			public command: string,
			public args: string[],
			public options: unknown,
		) {}
	},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, writeFileSync: mockWriteFileSync, mkdirSync: mockMkdirSync },
		existsSync: mockExistsSync,
		writeFileSync: mockWriteFileSync,
		mkdirSync: mockMkdirSync,
	}
})

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveCangjieToolPath,
	buildCangjieToolEnv: mockBuildCangjieToolEnv,
	formatCangjieToolchainReport: mockFormatCangjieToolchainReport,
	probeCangjieToolchain: mockProbeCangjieToolchain,
	CJC_CONFIG_KEY: "cangjieTools.cjcPath",
}))

vi.mock("../cangjieSourceLayout", () => ({
	inferCangjiePackageFromSrcLayout: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../cangjieGeneratedTestCleanup", () => ({
	registerGeneratedCangjieTestFile: vi.fn(),
	purgeAllTrackedCangjieTestFiles: vi.fn().mockReturnValue({ filesRemoved: 0, taskEntriesRemoved: 0 }),
}))

vi.mock("../../../core/prompts/sections/learnedFixesStorage", () => ({
	LEARNED_FIXES_FILE: "learned-fixes.json",
	ensureLearnedFixesFile: vi.fn(),
	getLearnedFixesJsonPath: vi.fn().mockReturnValue("/mock/learned-fixes.json"),
	loadLearnedFixes: vi.fn().mockReturnValue({ patterns: [] }),
	saveLearnedFixes: vi.fn(),
}))

vi.mock("../../../core/prompts/sections/cangjie-context", () => ({
	invalidateCangjieContextSectionCache: vi.fn(),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../../shared/package", () => ({
	Package: { resolve: vi.fn().mockReturnValue(null), name: "njust-ai" },
}))

vi.mock("@njust-ai/types", () => ({
	NJUST_AI_CONFIG_DIR: ".njust-ai",
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn() },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}))

import { registerCangjieCommands } from "../cangjieCommands"

describe("cangjieCommands", () => {
	let mockContext: any
	let mockLspClient: any

	beforeEach(() => {
		vi.clearAllMocks()

		const subscriptions: any[] = []
		mockContext = {
			subscriptions,
			globalState: {
				get: vi.fn(),
				update: vi.fn(),
			},
		}
		mockLspClient = {
			restart: vi.fn(),
		}
		mockCreateOutputChannel.mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
			show: vi.fn(),
		})
		mockCreateTerminal.mockReturnValue({
			show: vi.fn(),
			sendText: vi.fn(),
		})
	})

	it("registerCangjieCommands is a function", () => {
		expect(typeof registerCangjieCommands).toBe("function")
	})

	it("registers CJPM commands (build, run, test, check, clean)", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieBuild")
		expect(registeredIds).toContain("njust-ai.cangjieRun")
		expect(registeredIds).toContain("njust-ai.cangjieTest")
		expect(registeredIds).toContain("njust-ai.cangjieCheck")
		expect(registeredIds).toContain("njust-ai.cangjieClean")
	})

	it("registers verify SDK command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieVerifySdk")
	})

	it("registers generate test file command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieGenerateTestFile")
	})

	it("registers clean generated tests command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieCleanGeneratedTests")
	})

	it("registers restart LSP command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieRestartLsp")
	})

	it("registers profile command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieProfile")
	})

	it("registers template command", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieInsertTemplate")
	})

	it("registers learned fixes commands", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieViewLearnedFixes")
		expect(registeredIds).toContain("njust-ai.cangjieManageLearnedFixes")
	})

	it("registers refactoring commands when symbolIndex provided", () => {
		const mockSymbolIndex = {}
		registerCangjieCommands(mockContext, mockLspClient, mockSymbolIndex)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).toContain("njust-ai.cangjieExtractFunction")
		expect(registeredIds).toContain("njust-ai.cangjieMoveFile")
	})

	it("does not register refactoring commands when no symbolIndex", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		const registeredIds = mockRegisterCommand.mock.calls.map((c: any) => c[0])
		expect(registeredIds).not.toContain("njust-ai.cangjieExtractFunction")
		expect(registeredIds).not.toContain("njust-ai.cangjieMoveFile")
	})

	it("adds all disposables to context subscriptions", () => {
		registerCangjieCommands(mockContext, mockLspClient)

		// Should have many subscriptions (commands + event listeners + profiler)
		expect(mockContext.subscriptions.length).toBeGreaterThan(10)
	})
})
