import * as vscode from "vscode"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { Package } from "../shared/package"
import { detectCangjieHome } from "../services/cangjie-lsp/cangjieToolUtils"
import { RooToolsMcpServer } from "../services/mcp-server/RooToolsMcpServer"
import { getWorkspacePath } from "../utils/path"
import { getErrorMessage } from "../shared/error-utils"

export interface McpToolsServerDeps {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	defaultCommands: string[]
}

/**
 * Start MCP Tools Server if enabled in settings.
 * Handles auth token SecretStorage migration and workspace folder changes.
 */
export async function setupMcpToolsServer(deps: McpToolsServerDeps): Promise<void> {
	const { context, outputChannel, defaultCommands } = deps
	const mcpServerConfig = vscode.workspace.getConfiguration(Package.name)
	const mcpServerEnabled = mcpServerConfig.get<boolean>("mcpServer.enabled", false)
	if (!mcpServerEnabled) return

	const port = mcpServerConfig.get<number>("mcpServer.port", 3100)
	const bindAddress = mcpServerConfig.get<string>("mcpServer.bindAddress", "127.0.0.1")

	// Read MCP authToken from SecretStorage (preferred) or migrate from settings.
	const MCP_AUTH_TOKEN_SECRET_KEY = "njust-ai.mcpServer.authToken"
	let authToken = (await context.secrets.get(MCP_AUTH_TOKEN_SECRET_KEY)) || undefined
	if (!authToken) {
		// Migration: read legacy token from settings and store in SecretStorage.
		const legacyToken = mcpServerConfig.get<string>("mcpServer.authToken", "")
		if (legacyToken?.trim()) {
			authToken = legacyToken.trim()
			context.secrets.store(MCP_AUTH_TOKEN_SECRET_KEY, authToken).then(
				() => {
					mcpServerConfig.update("mcpServer.authToken", undefined, vscode.ConfigurationTarget.Global)
				},
				(err: unknown) => {
					outputChannel.appendLine(
						`[McpToolsServer] Failed to persist auth token to secret storage: ${getErrorMessage(err)}. ` +
							`MCP server authentication will not survive VS Code restart until this is resolved.`,
					)
				},
			)
		}
	}

	let rooToolsMcpServer: RooToolsMcpServer | undefined

	const startMcpServer = (wsPath: string) => {
		const cangjieHome = detectCangjieHome()
		const mergedAllowed = [...defaultCommands]
		if (cangjieHome) {
			mergedAllowed.push(cangjieHome)
		}
		rooToolsMcpServer = new RooToolsMcpServer({
			workspacePath: wsPath,
			port,
			bindAddress,
			authToken,
			allowedCommands: mergedAllowed,
			deniedCommands: mcpServerConfig.get<string[]>("deniedCommands", []),
		})

		rooToolsMcpServer
			.start()
			.then(() => {
				outputChannel.appendLine(
					`[McpToolsServer] Started on http://${bindAddress}:${port}/mcp (workspace: ${wsPath})`,
				)
				if (bindAddress === "0.0.0.0") {
					outputChannel.appendLine(
						`[McpToolsServer] WARNING: Server is accessible from remote machines. Ensure authToken is set and firewall rules are configured.`,
					)
				}
			})
			.catch((error) => {
				outputChannel.appendLine(`[McpToolsServer] Failed to start: ${getErrorMessage(error)}`)
				TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
			})

		context.subscriptions.push({
			dispose: () => {
				void rooToolsMcpServer?.stop()
			},
		})
	}

	const workspacePath = getWorkspacePath()
	if (workspacePath) {
		startMcpServer(workspacePath)
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const newPath = getWorkspacePath()
			if (!newPath) {
				return
			}
			if (rooToolsMcpServer) {
				rooToolsMcpServer.updateWorkspacePath(newPath)
				outputChannel.appendLine(`[McpToolsServer] Workspace path updated to: ${newPath}`)
			} else {
				startMcpServer(newPath)
			}
		}),
	)
}
