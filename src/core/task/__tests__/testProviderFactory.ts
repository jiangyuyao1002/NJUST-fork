import * as vscode from "vscode"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"

export { ClineProvider }

export function createTestProvider(
	mockContext?: Partial<vscode.ExtensionContext>,
	mockOutputChannel?: Partial<vscode.OutputChannel>,
): ClineProvider {
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
	} as unknown as vscode.ExtensionContext

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
	} as unknown as vscode.OutputChannel

	const contextProxy = new ContextProxy(context)
	return new ClineProvider(context, outputChannel, "sidebar", contextProxy)
}
