import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"

import { logger } from "../../../shared/logger"
import { TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { mergeSafeEnv } from "../../../utils/env"

import type { ITransportStrategy, TransportCallbacks } from "./ITransportStrategy"

const MAX_STREAM_RECONNECT = 6

export class StdioTransportStrategy implements ITransportStrategy {
	readonly type = "stdio"

	async createTransport(
		name: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<StdioClientTransport> {
		// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
		// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
		// commands as PowerShell scripts rather than executables.
		// Note: This adds a small overhead as commands go through an additional shell layer.
		const isWindows = process.platform === "win32"

		// Check if command is already cmd.exe to avoid double-wrapping
		const isAlreadyWrapped =
			config.command.toLowerCase() === "cmd.exe" || config.command.toLowerCase() === "cmd"

		const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : config.command
		const args =
			isWindows && !isAlreadyWrapped ? ["/c", config.command, ...(config.args || [])] : config.args

		const mergedEnv = mergeSafeEnv(getDefaultEnvironment(), config.env || {}, name)
		const env: Record<string, string> = {}
		for (const [key, value] of Object.entries(mergedEnv)) {
			if (value !== undefined) {
				env[key] = value
			}
		}

		const transport = new StdioClientTransport({
			command,
			args,
			cwd: config.cwd,
			env,
			stderr: "pipe",
		})

		// Set up stdio specific error handling
		transport.onerror = async (error) => {
			logger.error("McpHub", `Transport error for "${name}":`, error)
			await callbacks.onError(error)
		}

		let streamReconnectAttempts = 0
		transport.onclose = async () => {
			if (streamReconnectAttempts >= MAX_STREAM_RECONNECT) {
				logger.error("McpHub", `stdio "${name}" reconnect exhausted after ${MAX_STREAM_RECONNECT} attempts`)
				await callbacks.onClose()
				return
			}
			streamReconnectAttempts++
			const delay =
				Math.min(1000 * Math.pow(2, streamReconnectAttempts), 60_000) + Math.floor(Math.random() * 1000)
			logger.warn(
				"McpHub",
				`stdio "${name}" disconnected, reconnect attempt ${streamReconnectAttempts}/${MAX_STREAM_RECONNECT} in ${delay}ms`,
			)
			setTimeout(async () => {
				try {
					await transport.start()
					streamReconnectAttempts = 0
				} catch (reconnectErr) {
					logger.error("McpHub", `stdio "${name}" reconnect failed:`, reconnectErr)
					TelemetryService.reportError(reconnectErr, TelemetryEventName.MCP_ERROR)
					// onclose will fire again and trigger the next attempt
				}
			}, delay)
		}

		// Set up stderr listener BEFORE starting the transport so we don't miss
		// early startup errors (e.g. "command not found").
		const stderrStream = transport.stderr
		if (stderrStream) {
			stderrStream.on("data", (data: Buffer) => {
				const output = data.toString()
				// Check if output contains INFO level log
				const isInfoLog = /INFO/i.test(output)

				if (isInfoLog) {
					// Log normal informational messages
					logger.info("McpHub", `Server "${name}" info:`, output)
				} else {
					// Treat as error log
					logger.error("McpHub", `Server "${name}" stderr:`, output)
					callbacks.onStderr?.(data)
				}
			})
		} else {
			logger.error("McpHub", `No stderr stream for ${name}`)
		}

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

		// Monkey-patch start() to no-op so client.connect() doesn't try to start again
		transport.start = async () => {}

		return transport
	}
}
