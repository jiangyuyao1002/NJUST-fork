import * as fs from "fs/promises"

import { ListResourcesResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js"

import type { McpResource, McpTool } from "@njust-ai-cj/types"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { logger } from "../../shared/logger"

type McpHubInternal = UnsafeAny

export async function fetchToolsListWithHub(
	hub: McpHubInternal,
	serverName: string,
	source?: "global" | "project",
): Promise<McpTool[]> {
	try {
		// Use the helper method to find the connection
		const connection = hub.findConnection(serverName, source)

		if (!connection || connection.type !== "connected") {
			return []
		}

		const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema)

		// Determine the actual source of the server
		const actualSource = connection.server.source || "global"
		let configPath: string
		let alwaysAllowConfig: string[] = []
		let disabledToolsList: string[] = []

		// Read from the appropriate config file based on the actual source
		try {
			let serverConfigData: Record<string, UnsafeAny> = {}
			if (actualSource === "project") {
				// Get project MCP config path
				const projectMcpPath = await hub.getProjectMcpPath()
				if (projectMcpPath) {
					configPath = projectMcpPath
					const content = await fs.readFile(configPath, "utf-8")
					serverConfigData = JSON.parse(content)
				}
			} else {
				// Get global MCP settings path
				configPath = await hub.getMcpSettingsFilePath()
				const content = await fs.readFile(configPath, "utf-8")
				serverConfigData = JSON.parse(content)
			}
			if (serverConfigData) {
				alwaysAllowConfig = serverConfigData.mcpServers?.[serverName]?.alwaysAllow || []
				disabledToolsList = serverConfigData.mcpServers?.[serverName]?.disabledTools || []
			}
		} catch (error) {
			logger.error("McpHub", `Failed to read tool configuration for ${serverName}:`, error)
			// Continue with empty configs
		}

		// High-risk tools that never auto-approve, even with "*" wildcard.
		// Users must explicitly list these in alwaysAllow for them to auto-run.
		// New tools with destructive or network-access capabilities should be added here.
		const WILDCARD_DENY_TOOLS = new Set([
			"execute_command",
			"apply_diff",
			"apply_patch",
			"write_to_file",
			"new_task",
			"edit",
			"edit_file",
			"search_replace",
			"web_fetch",
			"web_search",
			"generate_image",
			"agent",
			"use_mcp_tool",
			"access_mcp_resource",
			"send_message",
		])
		// Check if wildcard "*" is in the alwaysAllow config
		const hasWildcard = alwaysAllowConfig.includes("*")

		// Mark tools as always allowed and enabled for prompt based on settings
		const MAX_MCP_TOOLS_PER_SERVER = 1000
		let tools = (response?.tools || []).map((tool: McpTool) => ({
			...tool,
			alwaysAllow: (hasWildcard && !WILDCARD_DENY_TOOLS.has(tool.name)) || alwaysAllowConfig.includes(tool.name),
			enabledForPrompt: !disabledToolsList.includes(tool.name),
		}))

		if (tools.length > MAX_MCP_TOOLS_PER_SERVER) {
			logger.warn(
				"McpHub",
				`Server "${serverName}" returned ${tools.length} tools, truncating to ${MAX_MCP_TOOLS_PER_SERVER}.`,
			)
			tools = tools.slice(0, MAX_MCP_TOOLS_PER_SERVER)
		}

		return tools
	} catch (error) {
		logger.error("McpHub", `Failed to fetch tools for ${serverName}:`, error)
		return []
	}
}

export async function fetchResourcesListWithHub(
	hub: McpHubInternal,
	serverName: string,
	source?: "global" | "project",
): Promise<McpResource[]> {
	try {
		const connection = hub.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			return []
		}
		const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema)
		return response?.resources || []
	} catch {
		return []
	}
}

export async function updateServerToolListWithHub(
	hub: McpHubInternal,
	serverName: string,
	source: "global" | "project",
	toolName: string,
	listName: "alwaysAllow" | "disabledTools",
	addTool: boolean,
): Promise<void> {
	// Find the connection with matching name and source
	const connection = hub.findConnection(serverName, source)

	if (!connection) {
		throw new Error(`Server ${serverName} with source ${source} not found`)
	}

	// Determine the correct config path based on the source
	let configPath: string
	if (source === "project") {
		// Get project MCP config path
		const projectMcpPath = await hub.getProjectMcpPath()
		if (!projectMcpPath) {
			throw new Error("Project MCP configuration file not found")
		}
		configPath = projectMcpPath
	} else {
		// Get global MCP settings path
		configPath = await hub.getMcpSettingsFilePath()
	}

	// Normalize path for cross-platform compatibility
	// Use a consistent path format for both reading and writing
	const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath

	// Read the appropriate config file
	const content = await fs.readFile(normalizedPath, "utf-8")
	const config = JSON.parse(content)

	if (!config.mcpServers) {
		config.mcpServers = {}
	}

	if (!config.mcpServers[serverName]) {
		config.mcpServers[serverName] = {
			type: "stdio",
			command: "node",
			args: [], // Default to an empty array; can be set later if needed
		}
	}

	if (!config.mcpServers[serverName][listName]) {
		config.mcpServers[serverName][listName] = []
	}

	const targetList = config.mcpServers[serverName][listName]
	const toolIndex = targetList.indexOf(toolName)

	if (addTool && toolIndex === -1) {
		targetList.push(toolName)
	} else if (!addTool && toolIndex !== -1) {
		targetList.splice(toolIndex, 1)
	}

	// Set flag to prevent file watcher from triggering server restart
	hub.setProgrammaticUpdateFlag()
	try {
		await safeWriteJson(normalizedPath, config, { prettyPrint: true })
	} finally {
		// Reset flag after watcher debounce period (non-blocking)
		hub.scheduleProgrammaticUpdateFlagReset()
	}

	if (connection) {
		connection.server.tools = await fetchToolsListWithHub(hub, serverName, source)
		await hub.notifyWebviewOfServerChanges()
	}
}

export async function toggleToolAlwaysAllowWithHub(
	hub: McpHubInternal,
	serverName: string,
	source: "global" | "project",
	toolName: string,
	shouldAllow: boolean,
): Promise<void> {
	try {
		await updateServerToolListWithHub(hub, serverName, source, toolName, "alwaysAllow", shouldAllow)
	} catch (error) {
		hub.showErrorMessage(
			`Failed to toggle always allow for tool "${toolName}" on server "${serverName}" with source "${source}"`,
			error,
		)
		throw error
	}
}

export async function toggleToolEnabledForPromptWithHub(
	hub: McpHubInternal,
	serverName: string,
	source: "global" | "project",
	toolName: string,
	isEnabled: boolean,
): Promise<void> {
	try {
		// When isEnabled is true, we want to remove the tool from the disabledTools list.
		// When isEnabled is false, we want to add the tool to the disabledTools list.
		const addToolToDisabledList = !isEnabled
		await updateServerToolListWithHub(hub, serverName, source, toolName, "disabledTools", addToolToDisabledList)
	} catch (error) {
		hub.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
		throw error // Re-throw to ensure the error is properly handled
	}
}
