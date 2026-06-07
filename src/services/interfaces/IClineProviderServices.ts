import type * as vscode from "vscode"
import type { IBypassStatusBar } from "./IBypassStatusBar"
import type { ICodeIndexManager } from "../code-index/interfaces/manager"
import type { ISkillsManager, ISkillsManagerHost } from "../skills/interfaces/ISkillsManager"
import type { IMemoryManager } from "../memory/interfaces/IMemoryManager"
import type { IMcpHubClient } from "../mcp/interfaces/IMcpHubClient"
import type { IMcpHubService } from "../mcp/interfaces/IMcpHubService"
import type { IProfileStorageService } from "./IProfileStorageService"
import type { ICangjiePromptServices } from "./ICangjiePromptServices"

/**
 * Aggregated facade for all services consumed by ClineProvider.
 * Keeps core/webview decoupled from services implementation details.
 */
export interface IClineProviderServices {
	/** Create a new BypassStatusBar instance */
	createBypassStatusBar(): IBypassStatusBar

	/** Get or create the singleton MCP hub service */
	getMcpHub(context: vscode.ExtensionContext, provider: IMcpHubClient): Promise<IMcpHubService>

	/** Unregister a provider from the MCP hub */
	unregisterMcpProvider(provider: IMcpHubClient): void

	/** Get the CodeIndexManager for a workspace */
	getCodeIndexManager(context: vscode.ExtensionContext, workspacePath?: string): ICodeIndexManager | undefined

	/** Get all active CodeIndexManager instances */
	getAllCodeIndexManagers(): ICodeIndexManager[]

	/** Create a new SkillsManager instance */
	createSkillsManager(host: ISkillsManagerHost): ISkillsManager

	/** Create a new MemoryManager instance */
	createMemoryManager(cwd: string): IMemoryManager

	/** Get the ProfileStorageService */
	getProfileStorageService(): IProfileStorageService

	/** Get NJUST-AI directories for a workspace */
	getRooDirectoriesForCwd(cwd: string): string[]

	/** Search workspace files */
	searchWorkspaceFiles(
		query: string,
		workspacePath: string,
		limit?: number,
	): Promise<{ path: string; type: "file" | "folder"; label?: string }[]>

	/** Get Cangjie prompt services */
	getCangjiePromptServices(): ICangjiePromptServices

	/** Dispose all tracked service instances */
	dispose(): Promise<void> | void
}
