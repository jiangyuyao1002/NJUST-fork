import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import type { ConnectedMcpConnection, McpConnection, McpHubInternal, ServerConfigSchema } from "./McpHub"
import type { z } from "zod"

import { injectVariables } from "../../utils/config"
import { sanitizeMcpName } from "../../utils/mcp-name"
import { logger } from "../../shared/logger"

import { TransportFactory } from "./transport/TransportFactory"
import type { TransportCallbacks } from "./transport/ITransportStrategy"

export async function connectToServerWithHub(
	hub: McpHubInternal,
	name: string,
	config: z.infer<typeof ServerConfigSchema>,
	source: "global" | "project" = "global",
): Promise<void> {
	// Remove existing connection if it exists with the same source
	await hub.deleteConnection(name, source)

	// Register the sanitized name for O(1) lookup
	const sanitizedName = sanitizeMcpName(name)
	hub.sanitizedNameRegistry.set(sanitizedName, name)

	// Check if MCP is globally enabled
	const mcpEnabled = await hub.isMcpEnabled()
	if (!mcpEnabled) {
		// Still create a connection object to track the server, but don't actually connect
		const connection = hub.createPlaceholderConnection(name, config, source, "mcpDisabled")
		hub.connections.push(connection)
		return
	}

	// Skip connecting to disabled servers
	if (config.disabled) {
		// Still create a connection object to track the server, but don't actually connect
		const connection = hub.createPlaceholderConnection(name, config, source, "serverDisabled")
		hub.connections.push(connection)
		return
	}

	// Set up file watchers for enabled servers
	hub.setupFileWatcher(name, config, source)

	try {
		const client = new Client(
			{
				name: "NJUST_AI_CJ",
				version: hub.providerRef.deref()?.getExtensionPackageVersion() ?? "1.0.0",
			},
			{
				capabilities: {},
			},
		)

		// Inject variables to the config (environment, magic variables,...)
		const configInjected = (await injectVariables(config, {
			env: process.env,
			workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
		})) as typeof config

		const factory = new TransportFactory()

		const callbacks: TransportCallbacks = {
			onError: async (error) => {
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
					appendErrorMessageToConnection(connection, error instanceof Error ? error.message : `${error}`)
				}
				await hub.notifyWebviewOfServerChanges()
			},
			onClose: async () => {
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
				}
				await hub.notifyWebviewOfServerChanges()
			},
			onStderr: (data) => {
				const output = data.toString()
				const connection = hub.findConnection(name, source)
				if (connection) {
					appendErrorMessageToConnection(connection, output)
					if (connection.server.status === "disconnected") {
						hub.notifyWebviewOfServerChanges().catch((err: Error) => {
							logger.error("McpHub", `Failed to notify webview of server changes:`, err)
						})
					}
				}
			},
		}

		const transport = await factory.create(name, configInjected.type, configInjected, callbacks)

		// Create a connected connection
		const connection: ConnectedMcpConnection = {
			type: "connected",
			server: {
				name,
				config: JSON.stringify(configInjected),
				status: "connecting",
				disabled: configInjected.disabled,
				source,
				projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
				errorHistory: [],
			},
			client,
			transport,
		}
		hub.connections.push(connection)

		// Connect (this will automatically start the transport)
		await client.connect(transport)
		connection.server.status = "connected"
		connection.server.error = ""
		connection.server.instructions = client.getInstructions()

		// Initial fetch of tools and resources
		connection.server.tools = await hub.fetchToolsList(name, source)
		connection.server.resources = await hub.fetchResourcesList(name, source)
		connection.server.resourceTemplates = await hub.fetchResourceTemplatesList(name, source)
	} catch (error) {
		// Update status with error
		const connection = hub.findConnection(name, source)
		if (connection) {
			connection.server.status = "disconnected"
			appendErrorMessageToConnection(connection, error instanceof Error ? error.message : `${error}`)
		}
		throw error
	}
}

export function appendErrorMessageToConnection(
	connection: McpConnection,
	error: string,
	level: "error" | "warn" | "info" = "error",
) {
	const MAX_ERROR_LENGTH = 1000
	const truncatedError =
		error.length > MAX_ERROR_LENGTH ? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)` : error

	// Add to error history
	if (!connection.server.errorHistory) {
		connection.server.errorHistory = []
	}

	connection.server.errorHistory.push({
		message: truncatedError,
		timestamp: Date.now(),
		level,
	})

	// Keep only the last 100 errors
	if (connection.server.errorHistory.length > 100) {
		connection.server.errorHistory = connection.server.errorHistory.slice(-100)
	}

	// Update the current error message
	connection.server.error = truncatedError
}
