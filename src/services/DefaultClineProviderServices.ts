import type * as vscode from "vscode"
import { BypassStatusBar } from "./BypassStatusBar"
import { McpServerManager } from "./mcp/McpServerManager"
import { CodeIndexManager } from "./code-index/manager"
import { SkillsManager } from "./skills/SkillsManager"
import { MemoryManager } from "./memory/memrl/MemoryManager"
import type { IClineProviderServices } from "./interfaces/IClineProviderServices"
import type { IBypassStatusBar } from "./interfaces/IBypassStatusBar"
import type { ICodeIndexManager } from "./code-index/interfaces/manager"
import type { ISkillsManager, ISkillsManagerHost } from "./skills/interfaces/ISkillsManager"
import type { SkillsManagerHost } from "./skills/SkillsManager"
import type { IMemoryManager } from "./memory/interfaces/IMemoryManager"
import type { IMcpHubClient } from "./mcp/interfaces/IMcpHubClient"
import type { IMcpHubService } from "./mcp/interfaces/IMcpHubService"
import type { IProfileStorageService } from "./interfaces/IProfileStorageService"
import { getProfileStorageService } from "./cloud-agent/ProfileStorageService"
import { CangjiePromptServices } from "./CangjiePromptServices"
import type { ICangjiePromptServices } from "./interfaces/ICangjiePromptServices"
import { getRooDirectoriesForCwd } from "./njust-ai-config/index.js"
import { searchWorkspaceFiles } from "./search/file-search"

/**
 * Default implementation of IClineProviderServices.
 * Delegates to existing service classes and functions.
 */
export class DefaultClineProviderServices implements IClineProviderServices {
	private bypassStatusBar?: BypassStatusBar
	private skillsManager?: SkillsManager
	private memoryManager?: MemoryManager

	createBypassStatusBar(): IBypassStatusBar {
		this.bypassStatusBar = new BypassStatusBar()
		return this.bypassStatusBar
	}

	async getMcpHub(context: vscode.ExtensionContext, provider: IMcpHubClient): Promise<IMcpHubService> {
		return McpServerManager.getInstance(context, provider)
	}

	unregisterMcpProvider(provider: IMcpHubClient): void {
		McpServerManager.unregisterProvider(provider)
	}

	getCodeIndexManager(context: vscode.ExtensionContext, workspacePath?: string): ICodeIndexManager | undefined {
		return CodeIndexManager.getInstance(context, workspacePath) as ICodeIndexManager | undefined
	}

	getAllCodeIndexManagers(): ICodeIndexManager[] {
		return CodeIndexManager.getAllInstances() as unknown as ICodeIndexManager[]
	}

	createSkillsManager(host: ISkillsManagerHost): ISkillsManager {
		// ISkillsManagerHost is structurally compatible with SkillsManagerHost
		this.skillsManager = new SkillsManager(host as unknown as SkillsManagerHost)
		return this.skillsManager
	}

	createMemoryManager(cwd: string): IMemoryManager {
		this.memoryManager = new MemoryManager(cwd)
		return this.memoryManager
	}

	getProfileStorageService(): IProfileStorageService {
		return getProfileStorageService()
	}

	getRooDirectoriesForCwd(cwd: string): string[] {
		return getRooDirectoriesForCwd(cwd)
	}

	searchWorkspaceFiles(
		query: string,
		workspacePath: string,
		limit?: number,
	): Promise<{ path: string; type: "file" | "folder"; label?: string }[]> {
		return searchWorkspaceFiles(query, workspacePath, limit)
	}

	getCangjiePromptServices(): ICangjiePromptServices {
		return new CangjiePromptServices()
	}

	async dispose(): Promise<void> {
		this.bypassStatusBar?.dispose()
		await this.skillsManager?.dispose()
		this.memoryManager?.dispose()
	}
}
