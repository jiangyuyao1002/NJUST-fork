import type { ITaskHost } from "../interfaces/ITaskHost"
import type { ContextProxy } from "../../config/ContextProxy"

export function createTestProvider(
	mockContext?: Partial<import("vscode").ExtensionContext>,
	mockOutputChannel?: Partial<import("vscode").OutputChannel>,
): ITaskHost {
	const context = {
		extensionUri: { fsPath: "/test/extension" },
		globalStorageUri: { fsPath: "/test/storage" },
		globalState: {
			get: vi.fn().mockReturnValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			keys: vi.fn().mockReturnValue([]),
		},
		workspaceState: {
			get: vi.fn().mockReturnValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			keys: vi.fn().mockReturnValue([]),
		},
		secrets: {
			get: vi.fn().mockResolvedValue(undefined),
			store: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			onDidChange: vi.fn(),
		},
		subscriptions: [],
		extensionPath: "/test/extension",
		extension: { packageJSON: { name: "njust-ai-cj", version: "1.0.0" } },
		asAbsolutePath: vi.fn((p: string) => `/test/extension/${p}`),
		storagePath: "/test/storage",
		logPath: "/test/logs",
		environmentVariableCollection: {
			replace: vi.fn(),
			append: vi.fn(),
			prepend: vi.fn(),
			get: vi.fn(),
			forEach: vi.fn(),
			clear: vi.fn(),
			description: undefined,
			persistent: true,
		} as any,
		...mockContext,
	} as unknown as import("vscode").ExtensionContext

	const outputChannel = {
		appendLine: vi.fn(),
		append: vi.fn(),
		clear: vi.fn(),
		hide: vi.fn(),
		name: "test-output",
		replace: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
		...mockOutputChannel,
	} as unknown as import("vscode").OutputChannel

	const contextProxy = {
		context,
		outputChannel,
		getState: vi.fn().mockResolvedValue({}),
		setState: vi.fn().mockResolvedValue(undefined),
		getSecret: vi.fn().mockResolvedValue(undefined),
		setSecret: vi.fn().mockResolvedValue(undefined),
		deleteSecret: vi.fn().mockResolvedValue(undefined),
		getWorkspaceState: vi.fn().mockResolvedValue(undefined),
		setWorkspaceState: vi.fn().mockResolvedValue(undefined),
		getGlobalState: vi.fn().mockResolvedValue(undefined),
		setGlobalState: vi.fn().mockResolvedValue(undefined),
	} as unknown as ContextProxy

	return {
		contextProxy,
		context,
		cwd: "/mock/workspace/path",
		log: vi.fn(),
		getState: vi.fn().mockResolvedValue({}),
		getMcpHub: vi.fn().mockReturnValue(undefined),
		getSkillsManager: vi.fn().mockReturnValue(undefined),
		delegateParentAndOpenChild: vi.fn().mockResolvedValue({} as any),
		setMode: vi.fn().mockResolvedValue(undefined),
		setProviderProfile: vi.fn().mockResolvedValue(undefined),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		cancelTask: vi.fn().mockResolvedValue(undefined),
		getTaskStackSize: vi.fn().mockReturnValue(0),
		convertToWebviewUri: vi.fn((filePath: string) => filePath),
		createDiffViewProvider: vi.fn().mockReturnValue(undefined),
		on: vi.fn(),
		off: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue("/test/mcp-servers"),
		ensureSettingsDirectoryExists: vi.fn().mockResolvedValue("/test/settings"),
		getExtensionPackageVersion: vi.fn().mockReturnValue("1.0.0"),
	} as unknown as ITaskHost
}
