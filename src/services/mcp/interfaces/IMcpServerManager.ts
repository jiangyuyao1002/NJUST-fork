import type * as vscode from "vscode"
import type { IMcpHubClient } from "./IMcpHubClient"
import type { IMcpHubService } from "./IMcpHubService"

/**
 * Factory for MCP server hub instances.
 * Abstracts the static singleton pattern of McpServerManager.
 */
export interface IMcpServerManager {
	getInstance(context: vscode.ExtensionContext, provider: IMcpHubClient): Promise<IMcpHubService>
	unregisterProvider(provider: IMcpHubClient): void
}
