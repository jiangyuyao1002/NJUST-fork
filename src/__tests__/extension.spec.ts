// npx vitest run __tests__/extension.spec.ts

import { describe, test, expect, vi, beforeEach } from "vitest"

import type * as vscode from "vscode"
import * as fsModule from "fs"
import * as dotenvxModule from "@dotenvx/dotenvx"

import { activate } from "../extension"

vi.mock("vscode", () => {
	const mockRegFn = () =>
		vi.fn().mockReturnValue({
			dispose: vi.fn(),
		})
	const mockFolder = {
		uri: { fsPath: "/test/workspace", scheme: "file", path: "/test/workspace" },
		name: "workspace",
		index: 0,
	}
	return {
		window: {
			createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn() }),
			registerWebviewViewProvider: vi.fn(),
			registerUriHandler: vi.fn(),
			tabGroups: { onDidChangeTabs: vi.fn() },
			onDidChangeActiveTextEditor: vi.fn(),
			createStatusBarItem: vi.fn().mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
			showInformationMessage: vi.fn().mockResolvedValue(undefined),
			showErrorMessage: vi.fn().mockResolvedValue(undefined),
			showWarningMessage: vi.fn().mockResolvedValue(undefined),
			createTerminal: vi.fn(),
			activeTextEditor: undefined,
		},
		workspace: {
			registerTextDocumentContentProvider: vi.fn(),
			getConfiguration: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue("") }),
			createFileSystemWatcher: vi
				.fn()
				.mockReturnValue({ onDidCreate: vi.fn(), onDidChange: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn() }),
			onDidChangeWorkspaceFolders: vi.fn(),
			onDidChangeConfiguration: vi.fn(),
			onDidSaveTextDocument: vi.fn(),
			getWorkspaceFolder: vi.fn().mockReturnValue(mockFolder),
			workspaceFolders: [],
		},
		languages: {
			registerCodeActionsProvider: vi.fn(),
			createDiagnosticCollection: vi.fn().mockReturnValue({ set: vi.fn(), clear: vi.fn(), delete: vi.fn() }),
			onDidChangeDiagnostics: vi.fn(),
			registerInlineCompletionItemProvider: mockRegFn(),
			registerDocumentSymbolProvider: vi.fn(),
			registerFoldingRangeProvider: vi.fn(),
			registerHoverProvider: vi.fn(),
			registerCodeLensProvider: vi.fn(),
			registerDocumentSemanticTokensProvider: vi.fn(),
			registerInlayHintsProvider: vi.fn(),
			registerDefinitionProvider: vi.fn(),
			registerReferenceProvider: vi.fn(),
			registerRenameProvider: vi.fn(),
			registerCallHierarchyProvider: vi.fn(),
			registerTypeHierarchyProvider: vi.fn(),
			registerWorkspaceSymbolProvider: vi.fn(),
		},
		debug: {
			registerDebugAdapterDescriptorFactory: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			registerDebugConfigurationProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			startDebugging: vi.fn().mockResolvedValue(undefined),
		},
		commands: {
			executeCommand: vi.fn(),
			registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		},
		chat: {
			createChatParticipant: vi.fn().mockReturnValue({
				iconPath: undefined,
				followupProvider: undefined,
				onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			}),
		},
		ChatResultFeedbackKind: { Helpful: 1, Unhelpful: 2 },
		lm: {
			registerTool: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		},
		env: { language: "en" },
		ExtensionMode: { Production: 1 },
		Uri: {
			parse: vi.fn(),
			file: vi.fn(() => ({ fsPath: "/test", with: vi.fn() })),
			joinPath: vi.fn(() => ({ fsPath: "/test" })),
		},
		EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
	}
})

vi.mock("@dotenvx/dotenvx", () => ({
	config: vi.fn(),
}))

// Mock vscode-languageclient/node to prevent deep import of "vscode" after vi.resetModules()
vi.mock("vscode-languageclient/node", () => ({
	LanguageClient: vi.fn(),
	TransportKind: { stdio: 0 },
}))

// Mock all cangjie-lsp modules to prevent deep vscode dependency chains after resetModules.
// Use mockResolvedValue for functions that extension.ts awaits or calls .then() on.
// Factory variables must be hoisted because vi.mock is hoisted to the top of the file.
const { mockAsyncFn, mockConstructor } = vi.hoisted(() => {
	const mockAsyncFn = () => vi.fn().mockResolvedValue(undefined)
	const mockConstructor = () =>
		vi.fn().mockImplementation(() => ({
			initialize: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn(),
			onCangjieActivated: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
		}))
	return { mockAsyncFn, mockConstructor }
})
vi.mock("../services/cangjie-lsp/CangjieLspClient", () => ({ CangjieLspClient: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieLspStatusBar", () => ({ CangjieLspStatusBar: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CjfmtFormatter", () => ({ CjfmtFormatter: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CjlintDiagnostics", () => ({ CjlintDiagnostics: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CjpmTaskProvider", () => ({ CjpmTaskProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/cangjieCommands", () => ({ registerCangjieCommands: vi.fn() }))
vi.mock("../services/cangjie-lsp/cangjieGeneratedTestCleanup", () => ({ cleanupOrphanedTestFiles: mockAsyncFn(), initTestCleanup: mockAsyncFn() }))
vi.mock("../services/cangjie-lsp/CangjieCodeActionProvider", () => ({ CangjieCodeActionProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieSdkSetup", () => ({ checkAndPromptSdkSetup: mockAsyncFn() }))
vi.mock("../services/cangjie-lsp/cangjieToolUtils", () => ({ probeCangjieToolchain: mockAsyncFn(), invalidateCangjieToolEnvCache: vi.fn() }))
vi.mock("../services/cangjie-lsp/CangjieDocumentSymbolProvider", () => ({ CangjieDocumentSymbolProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieFoldingRangeProvider", () => ({ CangjieFoldingRangeProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieHoverProvider", () => ({ CangjieHoverProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieTestCodeLensProvider", () => ({ CangjieTestCodeLensProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieDebugAdapterFactory", () => ({ CangjieDebugAdapterFactory: mockConstructor(), CangjieDebugConfigurationProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieSymbolIndex", () => ({ CangjieSymbolIndex: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieDefinitionProvider", () => ({ CangjieDefinitionProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieReferenceProvider", () => ({ CangjieReferenceProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieEnhancedRenameProvider", () => ({ CangjieEnhancedRenameProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieMacroProvider", () => ({ CangjieMacroCodeLensProvider: mockConstructor(), CangjieMacroHoverProvider: mockConstructor(), registerMacroCommands: vi.fn() }))
vi.mock("../services/cangjie-lsp/CangjieSemanticTokensProvider", () => ({ CangjieSemanticTokensProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieInlayHintsProvider", () => ({ CangjieInlayHintsProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieCallHierarchyProvider", () => ({ CangjieCallHierarchyProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieTypeHierarchyProvider", () => ({ CangjieTypeHierarchyProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieWorkspaceSymbolProvider", () => ({ CangjieWorkspaceSymbolProvider: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieCompileGuard", () => ({ CangjieCompileGuard: mockConstructor() }))
vi.mock("../services/cangjie-lsp/cangjieRulesHotReload", () => ({ registerCangjieRulesHotReload: vi.fn() }))
vi.mock("../services/cangjie-lsp/cangjieDiagnosticModeSwitch", () => ({ cangjieDiagnosticModeSwitch: vi.fn() }))
vi.mock("../services/cangjie-lsp/CangjieLintConfig", () => ({ CangjieLintConfig: mockConstructor() }))
vi.mock("../services/cangjie-lsp/CangjieMetricsCollector", () => ({ CangjieMetricsCollector: mockConstructor() }))
vi.mock("../services/cloud-agent/deviceToken", () => ({ setDeviceToken: vi.fn() }))
vi.mock("../services/cloud-agent/ProfileStorageService", () => ({
	ProfileStorageService: vi.fn().mockImplementation(() => ({
		getProfiles: vi.fn(() => []),
		getProfile: vi.fn(() => undefined),
		getActiveProfile: vi.fn(() => undefined),
		saveProfile: vi.fn().mockResolvedValue(undefined),
		deleteProfile: vi.fn().mockResolvedValue(undefined),
		setActiveProfileId: vi.fn().mockResolvedValue(undefined),
		migrateFromLegacyConfig: vi.fn().mockResolvedValue(null),
	})),
	setProfileStorageService: vi.fn(),
	getProfileStorageService: vi.fn(),
}))

// Mock fs so the extension module can safely check for optional .env.
vi.mock("fs", () => ({
	existsSync: vi.fn().mockReturnValue(false),
}))

vi.mock("@njust-ai-cj/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
		createInstance: vi.fn().mockReturnValue({
			register: vi.fn(),
			setProvider: vi.fn(),
			shutdown: vi.fn(),
		}),
		hasInstance: vi.fn().mockReturnValue(false),
		get instance() {
			return {
				register: vi.fn(),
				setProvider: vi.fn(),
				shutdown: vi.fn(),
			}
		},
	},
	PostHogTelemetryClient: vi.fn(),
}))

vi.mock("../utils/outputChannelLogger", () => ({
	createOutputChannelLogger: vi.fn().mockReturnValue(vi.fn()),
	createDualLogger: vi.fn().mockReturnValue(vi.fn()),
}))

vi.mock("../shared/package", () => ({
	Package: {
		name: "test-extension",
		outputChannel: "Test Output",
		version: "1.0.0",
	},
}))

vi.mock("../shared/language", () => ({
	formatLanguage: vi.fn().mockReturnValue("en"),
}))

vi.mock("../core/config/ContextProxy", () => ({
	ContextProxy: {
		getInstance: vi.fn().mockResolvedValue({
			getValue: vi.fn(),
			setValue: vi.fn(),
			getValues: vi.fn().mockReturnValue({}),
			getProviderSettings: vi.fn().mockReturnValue({}),
		}),
	},
}))

vi.mock("../integrations/editor/DiffViewProvider", () => ({
	DIFF_VIEW_URI_SCHEME: "test-diff-scheme",
}))

vi.mock("../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		initialize: vi.fn(),
		cleanup: vi.fn(),
	},
}))

vi.mock("../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		cleanup: vi.fn().mockResolvedValue(undefined),
		getInstance: vi.fn().mockResolvedValue(null),
		unregisterProvider: vi.fn(),
	},
}))

vi.mock("../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn().mockReturnValue(null),
	},
}))

vi.mock("../services/mdm/MdmService", () => ({
	MdmService: {
		createInstance: vi.fn().mockResolvedValue(null),
	},
}))

vi.mock("../utils/migrateSettings", () => ({
	migrateSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../core/config/autoImportSettings", () => ({
	autoImportSettings: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../extension/api", () => ({
	API: vi.fn().mockImplementation(() => ({})),
}))

vi.mock("../activate", () => ({
	handleUri: vi.fn(),
	registerCommands: vi.fn(),
	registerCodeActions: vi.fn(),
	registerTerminalActions: vi.fn(),
	CodeActionProvider: vi.fn().mockImplementation(() => ({
		providedCodeActionKinds: [],
	})),
}))

vi.mock("../i18n", () => ({
	initializeI18n: vi.fn(),
	t: vi.fn((key) => key),
}))

// Mock ClineProvider
vi.mock("../core/webview/ClineProvider", async () => {
	const mockInstance = {
		resolveWebviewView: vi.fn(),
		postMessageToWebview: vi.fn(),
		postStateToWebview: vi.fn(),
		postStateToWebviewWithoutClineMessages: vi.fn(),
		getState: vi.fn().mockResolvedValue({}),
		initializeCloudProfileSyncWhenReady: vi.fn().mockResolvedValue(undefined),
		providerSettingsManager: {},
		contextProxy: { getGlobalState: vi.fn() },
		customModesManager: {},
		upsertProviderProfile: vi.fn().mockResolvedValue(undefined),
	}
	return {
		ClineProvider: Object.assign(
			vi.fn().mockImplementation(() => mockInstance),
			{
				// Static method used by extension.ts
				getVisibleInstance: vi.fn().mockReturnValue(mockInstance),
				sideBarId: "njust-ai.SidebarProvider",
			},
		),
	}
})

// Mock modelCache to prevent network requests during module loading
const mockRefreshModels = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock("../api/providers/fetchers/modelCache", () => ({
	flushModels: vi.fn(),
	getModels: vi.fn().mockResolvedValue([]),
	initializeModelCacheRefresh: vi.fn(),
	refreshModels: mockRefreshModels,
}))

describe("extension.ts", () => {
	let mockContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

		mockContext = {
			extensionPath: "/test/path",
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn(),
			},
			globalStorageUri: { fsPath: "/test/global-storage", scheme: "file", path: "/test/global-storage" },
			storageUri: { fsPath: "/test/storage", scheme: "file", path: "/test/storage" },
			subscriptions: [],
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn(), onDidChange: vi.fn() },
		} as unknown as vscode.ExtensionContext
	})

	test("does not call dotenvx.config when optional .env does not exist", async () => {
		vi.clearAllMocks()
		vi.mocked(fsModule.existsSync).mockReturnValue(false)

		await activate(mockContext)

		expect(dotenvxModule.config).not.toHaveBeenCalled()
	})

	test("calls dotenvx.config when optional .env exists", async () => {
		vi.clearAllMocks()
		vi.mocked(fsModule.existsSync).mockReturnValue(true)

		await activate(mockContext)

		expect(dotenvxModule.config).toHaveBeenCalledTimes(1)
	})

	// Cloud-related auth tests removed in simplified version
})
