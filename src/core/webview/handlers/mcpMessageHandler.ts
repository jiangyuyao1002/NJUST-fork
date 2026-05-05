import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"

import { NJUST_AI_CONFIG_DIR, type WebviewMessage } from "@njust-ai-cj/types"
import { Package } from "../../../shared/package"
import { openFile } from "../../../integrations/misc/open-file"
import { fileExistsAtPath } from "../../../utils/fs"
import { t } from "../../../i18n"
import { safeWriteJson } from "../../../utils/safeWriteJson"

import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"

export function registerMcpHandlers(router: MessageRouter): void {
	router.register("allowedCommands", handleAllowedCommands)
	router.register("deniedCommands", handleDeniedCommands)
	router.register("openMcpSettings", handleOpenMcpSettings)
	router.register("openProjectMcpSettings", handleOpenProjectMcpSettings)
	router.register("deleteMcpServer", handleDeleteMcpServer)
	router.register("restartMcpServer", handleRestartMcpServer)
	router.register("toggleToolAlwaysAllow", handleToggleToolAlwaysAllow)
	router.register("toggleToolEnabledForPrompt", handleToggleToolEnabledForPrompt)
	router.register("toggleMcpServer", handleToggleMcpServer)
	router.register("refreshAllMcpServers", handleRefreshAllMcpServers)
	router.register("updateMcpTimeout", handleUpdateMcpTimeout)
	router.register("testWebSearch", handleTestWebSearch)
}

async function handleAllowedCommands(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { updateGlobalState } = context
	const commands = message.commands ?? []
	const validCommands = Array.isArray(commands)
		? commands.filter((cmd: unknown) => typeof cmd === "string" && (cmd as string).trim().length > 0)
		: []
	await updateGlobalState("allowedCommands", validCommands)
	await vscode.workspace.getConfiguration(Package.name).update("allowedCommands", validCommands, vscode.ConfigurationTarget.Global)
}

async function handleDeniedCommands(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { updateGlobalState } = context
	const commands = message.commands ?? []
	const validCommands = Array.isArray(commands)
		? commands.filter((cmd: unknown) => typeof cmd === "string" && (cmd as string).trim().length > 0)
		: []
	await updateGlobalState("deniedCommands", validCommands)
	await vscode.workspace.getConfiguration(Package.name).update("deniedCommands", validCommands, vscode.ConfigurationTarget.Global)
}

async function handleOpenMcpSettings(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const mcpSettingsFilePath = await context.provider.getMcpHub()?.getMcpSettingsFilePath()
	if (mcpSettingsFilePath) openFile(mcpSettingsFilePath)
}

async function handleOpenProjectMcpSettings(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, getCurrentCwd } = context
	if (!vscode.workspace.workspaceFolders?.length) {
		vscode.window.showErrorMessage(t("common:errors.no_workspace")); return
	}
	const workspaceFolder = getCurrentCwd()
	const rooDir = path.join(workspaceFolder, NJUST_AI_CONFIG_DIR)
	const mcpPath = path.join(rooDir, "mcp.json")
	try {
		await fs.mkdir(rooDir, { recursive: true })
		if (!(await fileExistsAtPath(mcpPath))) {
			await safeWriteJson(mcpPath, { mcpServers: {} }, { prettyPrint: true })
		}
		await openFile(mcpPath)
	} catch (error) {
		vscode.window.showErrorMessage(t("mcp:errors.create_json", { error: `${error}` }))
	}
}

async function handleDeleteMcpServer(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (!message.serverName) return
	try {
		provider.log(`Attempting to delete MCP server: ${message.serverName}`)
		await provider.getMcpHub()?.deleteServer(message.serverName, message.source as "global" | "project")
		provider.log(`Successfully deleted MCP server: ${message.serverName}`)
		await provider.postStateToWebview()
	} catch (error) {
		provider.log(`Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function handleRestartMcpServer(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		await provider.getMcpHub()?.restartConnection(message.text!, message.source as "global" | "project")
	} catch (error) {
		provider.log(`Failed to retry connection for ${message.text}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}
}

async function handleToggleToolAlwaysAllow(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		await provider.getMcpHub()?.toggleToolAlwaysAllow(message.serverName!, message.source as "global" | "project", message.toolName!, Boolean(message.alwaysAllow))
	} catch (error) {
		provider.log(`Failed to toggle auto-approve for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}
}

async function handleToggleToolEnabledForPrompt(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		await provider.getMcpHub()?.toggleToolEnabledForPrompt(message.serverName!, message.source as "global" | "project", message.toolName!, Boolean(message.isEnabled))
	} catch (error) {
		provider.log(`Failed to toggle enabled for prompt for tool ${message.toolName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}
}

async function handleToggleMcpServer(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		await provider.getMcpHub()?.toggleServerDisabled(message.serverName!, message.disabled!, message.source as "global" | "project")
	} catch (error) {
		provider.log(`Failed to toggle MCP server ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
	}
}

async function handleRefreshAllMcpServers(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const mcpHub = context.provider.getMcpHub()
	if (mcpHub) await mcpHub.refreshAllConnections()
}

async function handleUpdateMcpTimeout(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.serverName && typeof message.timeout === "number") {
		try {
			await provider.getMcpHub()?.updateServerTimeout(message.serverName, message.timeout, message.source as "global" | "project")
		} catch (error) {
			provider.log(`Failed to update timeout for ${message.serverName}: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.update_server_timeout"))
		}
	}
}

async function handleTestWebSearch(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const state = await provider.getState()
		const providerName = state?.webSearchProvider ?? "baidu-free"
		const apiKey = state?.webSearchApiKey ?? ""
		const serpApiEngine = state?.serpApiEngine ?? "bing"
		const { createSearchProvider } = await import("../../../services/web-search/WebSearchProvider")
		const searchProvider = createSearchProvider(providerName as any, apiKey, serpApiEngine as any)
		await searchProvider.search("test", 1)
		await provider.postMessageToWebview({ type: "webSearchStatus", text: JSON.stringify({ status: "ok", provider: providerName }) })
	} catch (error) {
		await provider.postMessageToWebview({ type: "webSearchStatus", text: JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) }) })
	}
}
