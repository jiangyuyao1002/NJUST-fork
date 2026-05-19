import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import ReconnectingEventSource from "reconnecting-eventsource"

import type { ConnectedMcpConnection, McpConnection } from "./McpHub"

import { injectVariables } from "../../utils/config"
import { sanitizeMcpName } from "../../utils/mcp-name"
import { logger } from "../../shared/logger"
import { TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

type McpHubInternal = UnsafeAny

export async function connectToServerWithHub(
	hub: McpHubInternal,
	name: string,
	config: UnsafeAny,
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

		let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

		// Inject variables to the config (environment, magic variables,...)
		const configInjected = (await injectVariables(config, {
			env: process.env,
			workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
		})) as typeof config

		if (configInjected.type === "stdio") {
			// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
			// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
			// commands as PowerShell scripts rather than executables.
			// Note: This adds a small overhead as commands go through an additional shell layer.
			const isWindows = process.platform === "win32"

			// Check if command is already cmd.exe to avoid double-wrapping
			const isAlreadyWrapped =
				configInjected.command.toLowerCase() === "cmd.exe" || configInjected.command.toLowerCase() === "cmd"

			const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : configInjected.command
			const args =
				isWindows && !isAlreadyWrapped
					? ["/c", configInjected.command, ...(configInjected.args || [])]
					: configInjected.args

			transport = new StdioClientTransport({
				command,
				args,
				cwd: configInjected.cwd,
				env: {
					...getDefaultEnvironment(),
					...(configInjected.env || {}),
				},
				stderr: "pipe",
			})

			// Set up stdio specific error handling
			transport.onerror = async (error) => {
				logger.error("McpHub", `Transport error for "${name}":`, error)
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
					appendErrorMessageToConnection(connection, error instanceof Error ? error.message : `${error}`)
				}
				await hub.notifyWebviewOfServerChanges()
			}

			let streamReconnectAttempts = 0
			const MAX_STREAM_RECONNECT = 6
			transport.onclose = async () => {
				const connection = hub.findConnection(name, source)
				if (!connection) return
				if (streamReconnectAttempts >= MAX_STREAM_RECONNECT) {
					connection.server.status = "disconnected"
					logger.error("McpHub", `Streamable HTTP "${name}" reconnect exhausted after ${MAX_STREAM_RECONNECT} attempts`)
					await hub.notifyWebviewOfServerChanges()
					return
				}
				streamReconnectAttempts++
				const delay =
					Math.min(1000 * Math.pow(2, streamReconnectAttempts), 60_000) + Math.floor(Math.random() * 1000)
				logger.warn(
					"McpHub",
					`Streamable HTTP "${name}" disconnected, reconnect attempt ${streamReconnectAttempts}/${MAX_STREAM_RECONNECT} in ${delay}ms`,
				)
				setTimeout(async () => {
					try {
						await transport.start()
						if (connection) {
							connection.server.status = "connected"
							streamReconnectAttempts = 0
							await hub.notifyWebviewOfServerChanges()
						}
					} catch (reconnectErr) {
						logger.error("McpHub", `Streamable HTTP "${name}" reconnect failed:`, reconnectErr)
						TelemetryService.reportError(reconnectErr, TelemetryEventName.MCP_ERROR)
						// onclose will fire again and trigger the next attempt
					}
				}, delay)
			}

			// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
			// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
			await transport.start()
			// Prevent the child process from blocking VS Code exit.
			const childProcess = (transport as Record<string, UnsafeAny>).process
			if (childProcess && typeof childProcess.unref === "function") {
				childProcess.unref()
				childProcess.on("exit", (code: number | null, signal: string | null) => {
					logger.warn("McpHub", `Server "${name}" child process exited (code=${code}, signal=${signal})`)
				})
				childProcess.on("error", (err: Error) => {
					logger.error("McpHub", `Server "${name}" child process error:`, err)
				})
			}
			const stderrStream = transport.stderr
			if (stderrStream) {
				stderrStream.on("data", async (data: Buffer) => {
					const output = data.toString()
					// Check if output contains INFO level log
					const isInfoLog = /INFO/i.test(output)

					if (isInfoLog) {
						// Log normal informational messages
						logger.info("McpHub", `Server "${name}" info:`, output)
					} else {
						// Treat as error log
						logger.error("McpHub", `Server "${name}" stderr:`, output)
						const connection = hub.findConnection(name, source)
						if (connection) {
							appendErrorMessageToConnection(connection, output)
							if (connection.server.status === "disconnected") {
								await hub.notifyWebviewOfServerChanges()
							}
						}
					}
				})
			} else {
				logger.error("McpHub", `No stderr stream for ${name}`)
			}
		} else if (configInjected.type === "streamable-http") {
			// Streamable HTTP connection
			transport = new StreamableHTTPClientTransport(new URL(configInjected.url), {
				requestInit: {
					headers: configInjected.headers,
				},
			})

			// Set up Streamable HTTP specific error handling
			transport.onerror = async (error) => {
				logger.error("McpHub", `Transport error for "${name}" (streamable-http):`, error)
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
					appendErrorMessageToConnection(connection, error instanceof Error ? error.message : `${error}`)
				}
				await hub.notifyWebviewOfServerChanges()
			}

			transport.onclose = async () => {
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
				}
				await hub.notifyWebviewOfServerChanges()
			}
		} else if (configInjected.type === "sse") {
			// SSE connection
			const sseOptions = {
				requestInit: {
					headers: configInjected.headers,
				},
			}
			// Configure ReconnectingEventSource options with exponential
			// backoff and jitter to avoid thundering-herd on reconnect.
			const baseRetryMs = 1000
			const maxRetryMs = 60_000
			const jitter = Math.floor(Math.random() * 1000)
			const expBackoff = Math.min(baseRetryMs * Math.pow(2, Math.min(0, 5)), maxRetryMs)
			const reconnectingEventSourceOptions = {
				max_retry_time: expBackoff + jitter,
				withCredentials: configInjected.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
				fetch: (url: string | URL, init: RequestInit) => {
					const headers = new Headers({ ...(init?.headers || {}), ...(configInjected.headers || {}) })
					return fetch(url, {
						...init,
						headers,
					})
				},
			}
			global.EventSource = ReconnectingEventSource
			transport = new SSEClientTransport(new URL(configInjected.url), {
				...sseOptions,
				eventSourceInit: reconnectingEventSourceOptions,
			})

			// Set up SSE specific error handling
			transport.onerror = async (error) => {
				logger.error("McpHub", `Transport error for "${name}":`, error)
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
					appendErrorMessageToConnection(connection, error instanceof Error ? error.message : `${error}`)
				}
				await hub.notifyWebviewOfServerChanges()
			}

			transport.onclose = async () => {
				const connection = hub.findConnection(name, source)
				if (connection) {
					connection.server.status = "disconnected"
				}
				await hub.notifyWebviewOfServerChanges()
			}
		} else {
			// Should not happen if validateServerConfig is correct
			throw new Error(`Unsupported MCP server type: ${(configInjected as Record<string, UnsafeAny>).type}`)
		}

		// Only override transport.start for stdio transports that have already been started
		if (configInjected.type === "stdio") {
			transport.start = async () => {}
		}

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
