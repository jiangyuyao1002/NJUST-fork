import * as fs from "fs/promises"

import * as vscode from "vscode"

import { t } from "../../i18n"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

type McpHubInternal = UnsafeAny

export async function toggleServerDisabledWithHub(
	hub: McpHubInternal,
	serverName: string,
	disabled: boolean,
	source?: "global" | "project",
): Promise<void> {
	try {
		// Find the connection to determine if it's a global or project server
		const connection = hub.findConnection(serverName, source)
		if (!connection) {
			throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
		}

		const serverSource = connection.server.source || "global"
		// Update the server config in the appropriate file
		await updateServerConfigWithHub(hub, serverName, { disabled }, serverSource)

		// Update the connection object
		if (connection) {
			try {
				connection.server.disabled = disabled

				// If disabling a connected server, disconnect it
				if (disabled && connection.server.status === "connected") {
					// Clean up file watchers when disabling
					hub.removeFileWatchersForServer(serverName)
					await hub.deleteConnection(serverName, serverSource)
					// Re-add as a disabled connection
					// Re-read config from file to get updated disabled state
					const updatedConfig = await readServerConfigFromFileWithHub(hub, serverName, serverSource)
					await hub.connectToServer(serverName, updatedConfig, serverSource)
				} else if (!disabled && connection.server.status === "disconnected") {
					// If enabling a disabled server, connect it
					// Re-read config from file to get updated disabled state
					const updatedConfig = await readServerConfigFromFileWithHub(hub, serverName, serverSource)
					await hub.deleteConnection(serverName, serverSource)
					// When re-enabling, file watchers will be set up in connectToServer
					await hub.connectToServer(serverName, updatedConfig, serverSource)
				} else if (connection.server.status === "connected") {
					// Only refresh capabilities if connected
					connection.server.tools = await hub.fetchToolsList(serverName, serverSource)
					connection.server.resources = await hub.fetchResourcesList(serverName, serverSource)
					connection.server.resourceTemplates = await hub.fetchResourceTemplatesList(serverName, serverSource)
				}
			} catch (error) {
				logger.error("McpHub", `Failed to refresh capabilities for ${serverName}:`, error)
				TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
			}
		}

		await hub.notifyWebviewOfServerChanges()
	} catch (error) {
		hub.showErrorMessage(`Failed to update server ${serverName} state`, error)
		throw error
	}
}

export async function readServerConfigFromFileWithHub(
	hub: McpHubInternal,
	serverName: string,
	source: "global" | "project" = "global",
): Promise<UnsafeAny> {
	// Determine which config file to read
	let configPath: string
	if (source === "project") {
		const projectMcpPath = await hub.getProjectMcpPath()
		if (!projectMcpPath) {
			throw new Error("Project MCP configuration file not found")
		}
		configPath = projectMcpPath
	} else {
		configPath = await hub.getMcpSettingsFilePath()
	}

	// Ensure the settings file exists and is accessible
	try {
		await fs.access(configPath)
	} catch (error) {
		logger.error("McpHub", "Settings file not accessible:", error)
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
		throw new Error("Settings file not accessible")
	}

	// Read and parse the config file
	const content = await fs.readFile(configPath, "utf-8")
	const config = JSON.parse(content)

	// Validate the config structure
	if (!config || typeof config !== "object") {
		throw new Error("Invalid config structure")
	}

	if (!config.mcpServers || typeof config.mcpServers !== "object") {
		throw new Error("No mcpServers section in config")
	}

	if (!config.mcpServers[serverName]) {
		throw new Error(`Server ${serverName} not found in config`)
	}

	// Validate and return the server config
	return hub.validateServerConfig(config.mcpServers[serverName], serverName)
}

export async function updateServerConfigWithHub(
	hub: McpHubInternal,
	serverName: string,
	configUpdate: Record<string, UnsafeAny>,
	source: "global" | "project" = "global",
): Promise<void> {
	// Determine which config file to update
	let configPath: string
	if (source === "project") {
		const projectMcpPath = await hub.getProjectMcpPath()
		if (!projectMcpPath) {
			throw new Error("Project MCP configuration file not found")
		}
		configPath = projectMcpPath
	} else {
		configPath = await hub.getMcpSettingsFilePath()
	}

	// Ensure the settings file exists and is accessible
	try {
		await fs.access(configPath)
	} catch (error) {
		logger.error("McpHub", "Settings file not accessible:", error)
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
		throw new Error("Settings file not accessible")
	}

	// Read and parse the config file
	const content = await fs.readFile(configPath, "utf-8")
	const config = JSON.parse(content)

	// Validate the config structure
	if (!config || typeof config !== "object") {
		throw new Error("Invalid config structure")
	}

	if (!config.mcpServers || typeof config.mcpServers !== "object") {
		config.mcpServers = {}
	}

	if (!config.mcpServers[serverName]) {
		config.mcpServers[serverName] = {}
	}

	// Create a new server config object to ensure clean structure
	const serverConfig = {
		...config.mcpServers[serverName],
		...configUpdate,
	}

	// Ensure required fields exist
	if (!serverConfig.alwaysAllow) {
		serverConfig.alwaysAllow = []
	}

	config.mcpServers[serverName] = serverConfig

	// Write the entire config back
	const updatedConfig = {
		mcpServers: config.mcpServers,
	}

	// Set flag to prevent file watcher from triggering server restart
	hub.setProgrammaticUpdateFlag()
	try {
		await safeWriteJson(configPath, updatedConfig, { prettyPrint: true })
	} finally {
		// Reset flag after watcher debounce period (non-blocking)
		hub.scheduleProgrammaticUpdateFlagReset()
	}
}

export async function updateServerTimeoutWithHub(
	hub: McpHubInternal,
	serverName: string,
	timeout: number,
	source?: "global" | "project",
): Promise<void> {
	try {
		// Find the connection to determine if it's a global or project server
		const connection = hub.findConnection(serverName, source)
		if (!connection) {
			throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
		}

		// Update the server config in the appropriate file
		await updateServerConfigWithHub(hub, serverName, { timeout }, connection.server.source || "global")

		await hub.notifyWebviewOfServerChanges()
	} catch (error) {
		hub.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
		throw error
	}
}

export async function deleteServerWithHub(
	hub: McpHubInternal,
	serverName: string,
	source?: "global" | "project",
): Promise<void> {
	try {
		// Find the connection to determine if it's a global or project server
		const connection = hub.findConnection(serverName, source)
		if (!connection) {
			throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
		}

		const serverSource = connection.server.source || "global"
		// Determine config file based on server source
		const isProjectServer = serverSource === "project"
		let configPath: string

		if (isProjectServer) {
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

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch {
			throw new Error("Settings file not accessible")
		}

		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			config.mcpServers = {}
		}

		// Remove the server from the settings
		if (config.mcpServers[serverName]) {
			delete config.mcpServers[serverName]

			// Write the entire config back
			const updatedConfig = {
				mcpServers: config.mcpServers,
			}

			await safeWriteJson(configPath, updatedConfig, { prettyPrint: true })

			// Update server connections with the correct source
			await hub.updateServerConnections(config.mcpServers, serverSource)

			vscode.window.showInformationMessage(t("mcp:info.server_deleted", { serverName }))
		} else {
			vscode.window.showWarningMessage(t("mcp:info.server_not_found", { serverName }))
		}
	} catch (error) {
		hub.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
		throw error
	}
}
