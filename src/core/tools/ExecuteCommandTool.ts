import fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { z } from "zod"

import delay from "delay"

import { CommandExecutionStatus, DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE, PersistedCommandOutput, TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

import { Task } from "../task/Task"

import { ToolUse, ToolResponse } from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import { buildCangjieExecuteCommandErrorAppendix } from "../prompts/sections/cangjie-context"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { ExitCodeDetails, RooTerminalCallbacks, RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../integrations/terminal/Terminal"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { Package } from "../../shared/package"
import { t } from "../../i18n"
import { ignoreAbortError } from "../../utils/errorHandling"
import { getTaskDirectoryPath } from "../../utils/storage"
import { normalizeDotSlashCommandForWindowsShell } from "../../utils/hostShellCommand"
import { BaseTerminal } from "../../integrations/terminal/BaseTerminal"
import { BaseTool, ToolCallbacks, type ValidationResult } from "./BaseTool"
import { recordSecurityMetric } from "../security/metrics"
import { checkCommandSafety } from "./helpers/commandSafety"
import { logger } from "../../shared/logger"
import { TIMING } from "../../shared/constants"

/** Uses {@link checkCommandSafety} so high-risk detection stays aligned with permission classifiers. */
function _isHighRiskShellCommand(command: string): boolean {
	const { riskLevel } = checkCommandSafety(command)
	return riskLevel === "forbidden" || riskLevel === "dangerous"
}

class ShellIntegrationError extends Error {}

interface ExecuteCommandParams {
	command: string
	cwd?: string
	timeout?: number | null
}

const MIN_CLI_TIMEOUT_MS = TIMING.MIN_CLI_TIMEOUT_MS

export function resolveAgentTimeoutMs(timeoutSeconds: number | null | undefined): number {
	const requestedAgentTimeout = typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0

	// In CLI runtime, apply a minimum timeout to prevent permanent blocking
	// from malicious or malformed commands. User settings can extend but not
	// reduce below the floor.
	if (process.env.ROO_CLI_RUNTIME === "1") {
		return requestedAgentTimeout > 0
			? Math.max(requestedAgentTimeout, MIN_CLI_TIMEOUT_MS)
			: MIN_CLI_TIMEOUT_MS
	}
	return requestedAgentTimeout
}

export class ExecuteCommandTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const
	override readonly maxResultSizeChars = 100_000

	protected override get inputSchema() {
		return z.object({
			command: z.string().min(1, "command is required"),
			cwd: z.string().optional().nullable(),
			timeout: z.number().optional().nullable(),
		})
	}

	override validateInput(params: ExecuteCommandParams): ValidationResult {
		if (!params.command || params.command.trim() === "") {
			return { valid: false, error: "Command is required and cannot be empty." }
		}
		return { valid: true }
	}

	async execute(params: ExecuteCommandParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { command, cwd: customCwd, timeout: timeoutSeconds } = params
		const { handleError, pushToolResult, askApproval, reportProgress } = callbacks

		try {

			const canonicalCommand = unescapeHtmlEntities(command)
			await reportProgress?.({ icon: "terminal", text: "Preparing command execution" })

			if (task.taskMode === "cangjie") {
				const cangjieCommandError = task.cangjieRuntimePolicy.validateCommandSurface(canonicalCommand)
				if (cangjieCommandError) {
					task.recordToolError("execute_command", cangjieCommandError)
					pushToolResult(formatResponse.toolError(cangjieCommandError))
					return
				}
			}

			{
				const earlyState = await task.providerRef.deref()?.getState()
				if (earlyState?.enableWebSearch && isHttpCommand(canonicalCommand)) {
					pushToolResult(
						"This command attempts to make an HTTP request (curl/wget/etc.), which is blocked. " +
							"Use the web_search tool instead to retrieve information from the internet. " +
							'Example: { "search_query": "your query here", "count": 5 }',
					)
					return
				}
			}

			const ignoredFileAttemptedToAccess = task.rooIgnoreController?.validateCommand(canonicalCommand)

			if (ignoredFileAttemptedToAccess) {
				await task.say("rooignore_error", ignoredFileAttemptedToAccess)
				pushToolResult(formatResponse.rooIgnoreError(ignoredFileAttemptedToAccess))
				return
			}

			task.consecutiveMistakeCount = 0

			const safetyCheck = checkCommandSafety(canonicalCommand)
			const isBypassMode = (task as Task & { permissionRuleEngine?: { getMode(): string } }).permissionRuleEngine?.getMode?.() === "bypass"

			// Always block forbidden commands, even in bypass mode
			if (safetyCheck.riskLevel === "forbidden") {
				logger.warn("ExecuteCommandTool", "execute_command: forbidden command blocked:", canonicalCommand)
				recordSecurityMetric("execute_command_high_risk", {
					cmd: canonicalCommand.slice(0, 240),
					riskLevel: safetyCheck.riskLevel,
					reasons: safetyCheck.reasons.slice(0, 5).join(", "),
				})
				pushToolResult(formatResponse.toolError(`Forbidden command blocked: ${safetyCheck.reasons.join("; ")}`))
				return
			}

			if (safetyCheck.requiresConfirmation && !isBypassMode) {
				logger.warn("ExecuteCommandTool", "execute_command: high-risk pattern; user must approve in UI:", canonicalCommand)
				recordSecurityMetric("execute_command_high_risk", {
					cmd: canonicalCommand.slice(0, 240),
					riskLevel: safetyCheck.riskLevel,
					reasons: safetyCheck.reasons.slice(0, 5).join(", "),
				})
			}

			await reportProgress?.({ icon: "terminal", text: "Waiting for command approval" } as UnsafeAny)
			const approvalMessage = safetyCheck.requiresConfirmation && !isBypassMode
				? `[High risk] This command may destroy data. Confirm to run:\n${canonicalCommand}\n\nReasons: ${safetyCheck.reasons.join("; ")}`
				: canonicalCommand

			if (!isBypassMode) {
				const didApprove = await askApproval("command", approvalMessage)
				if (!didApprove) {
					return
				}
			}

			const saveAllBeforeExecute = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("saveAllBeforeExecuteCommand", true)
			if (saveAllBeforeExecute) {
				await vscode.workspace.saveAll(false)
			}

			await reportProgress?.({ icon: "terminal", text: "Starting command execution" } as UnsafeAny)
			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			const provider = await task.providerRef.deref()
			const providerState = await provider?.getState()

			const { terminalShellIntegrationDisabled = true } = providerState ?? {}

			// Get command execution timeout from VSCode configuration (in seconds)
			const commandExecutionTimeoutSeconds = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("commandExecutionTimeout", 0)

			// Get command timeout allowlist from VSCode configuration
			const commandTimeoutAllowlist = vscode.workspace
				.getConfiguration(Package.name)
				.get<string[]>("commandTimeoutAllowlist", [])

			// Check if command matches any prefix in the allowlist
			const isCommandAllowlisted = commandTimeoutAllowlist.some((prefix) =>
				canonicalCommand.startsWith(prefix.trim()),
			)

			// Convert seconds to milliseconds for internal use, but skip timeout if command is allowlisted
			const commandExecutionTimeout = isCommandAllowlisted ? 0 : commandExecutionTimeoutSeconds * 1000

			// Convert agent-specified timeout from seconds to milliseconds
			const agentTimeout = resolveAgentTimeoutMs(timeoutSeconds)

			const options: ExecuteCommandOptions = {
				executionId,
				command: canonicalCommand,
				customCwd,
				terminalShellIntegrationDisabled,
				commandExecutionTimeout,
				agentTimeout,
			}

			try {
				const [rejected, result] = await executeCommandInTerminal(task, options)

				if (rejected) {
					task.didRejectTool = true
				}

				if (task.taskMode === "cangjie") {
					task.cangjieRuntimePolicy.noteBuildResult(
						canonicalCommand,
						!rejected && !/^Command execution failed/i.test(String(result)),
						String(result),
					)
				}

				pushToolResult(result)
			} catch (error: UnsafeAny) {
				const status: CommandExecutionStatus = { executionId, status: "fallback" }
				void provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
				await task.say("shell_integration_warning")

				// Invalidate pending ask from first execution to prevent race condition
				task.supersedePendingAsk()

				if (error instanceof ShellIntegrationError) {
					const [rejected, result] = await executeCommandInTerminal(task, {
						...options,
						terminalShellIntegrationDisabled: true,
					})

					if (rejected) {
						task.didRejectTool = true
					}

					if (task.taskMode === "cangjie") {
						task.cangjieRuntimePolicy.noteBuildResult(
							canonicalCommand,
							!rejected && !/^Command execution failed/i.test(String(result)),
							String(result),
						)
					}

					pushToolResult(result)
				} else {
					pushToolResult(`Command failed to execute in terminal due to a shell integration error.`)
				}
			}

			return
		} catch (error) {
			await handleError("executing command", error as Error)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"execute_command">): Promise<void> {
		const command = block.params.command
		await task.ask("command", command ?? "", block.partial).catch(ignoreAbortError)
	}
}

export type ExecuteCommandOptions = {
	executionId: string
	command: string
	customCwd?: string
	terminalShellIntegrationDisabled?: boolean
	commandExecutionTimeout?: number
	agentTimeout?: number
}

export async function executeCommandInTerminal(
	task: Task,
	{
		executionId,
		command,
		customCwd,
		terminalShellIntegrationDisabled = true,
		commandExecutionTimeout = 0,
		agentTimeout = 0,
	}: ExecuteCommandOptions,
): Promise<[boolean, ToolResponse]> {
	// Convert milliseconds back to seconds for display purposes.
	const commandExecutionTimeoutSeconds = commandExecutionTimeout / 1000
	let workingDir: string

	if (!customCwd) {
		workingDir = task.cwd
	} else if (path.isAbsolute(customCwd)) {
		workingDir = customCwd
	} else {
		workingDir = path.resolve(task.cwd, customCwd)
	}

	try {
		await fs.access(workingDir)
	} catch {
		return [false, `Working directory '${workingDir}' does not exist.`]
	}

	const resolvedCommand = normalizeDotSlashCommandForWindowsShell(
		command.trim(),
		BaseTerminal.getExecaShellPath(),
	)

	let message: { text?: string; images?: string[] } | undefined
	let runInBackground = false
	let completed = false
	let result: string = ""
	let persistedResult: PersistedCommandOutput | undefined
	let exitDetails: ExitCodeDetails | undefined
	let shellIntegrationError: string | undefined
	let hasAskedForCommandOutput = false

	const terminalProvider = terminalShellIntegrationDisabled ? "execa" : "vscode"
	const provider = await task.providerRef.deref()

	// Get global storage path for persisted output artifacts
	const globalStoragePath = provider?.context?.globalStorageUri?.fsPath
	let interceptor: OutputInterceptor | undefined

	// Create OutputInterceptor if we have storage available
	if (globalStoragePath) {
		const taskDir = await getTaskDirectoryPath(globalStoragePath, task.taskId)
		const storageDir = path.join(taskDir, "command-output")
		const providerState = await provider?.getState()
		const terminalOutputPreviewSize =
			providerState?.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE

		interceptor = new OutputInterceptor({
			executionId,
			taskId: task.taskId,
			command: resolvedCommand,
			storageDir,
			previewSize: terminalOutputPreviewSize,
		})
	}

	let accumulatedOutput = ""
	// Bound accumulated output buffer size to prevent unbounded memory growth for long-running commands.
	// The interceptor preserves full output; this buffer is only for UI display (100KB limit).
	const maxAccumulatedOutputSize = 100_000
	const commandOutputStreamThrottleMs = 150
	let latestCompressedOutput = ""
	let lastQueuedCommandOutput = ""
	let lastCommandOutputEmitAt = 0
	let pendingCommandOutputEmitTimer: NodeJS.Timeout | undefined
	let commandOutputSayChain: Promise<void> = Promise.resolve()

	const queueCommandOutputMessage = (text: string, partial: boolean, force = false): Promise<void> => {
		if (!force && text === lastQueuedCommandOutput) {
			return commandOutputSayChain
		}

		lastQueuedCommandOutput = text
		commandOutputSayChain = commandOutputSayChain
			.then(async () => {
				await task.say("command_output", text, undefined, partial, undefined, undefined, {
					isNonInteractive: true,
				})
			})
			.catch((error) => {
				logger.error("ExecuteCommandTool", "Failed to publish command output:", error)
				TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
			})

		return commandOutputSayChain
	}

	const schedulePartialCommandOutputUpdate = () => {
		if (!latestCompressedOutput || completed) {
			return
		}

		const emitUpdate = () => {
			pendingCommandOutputEmitTimer = undefined
			lastCommandOutputEmitAt = Date.now()
			void queueCommandOutputMessage(latestCompressedOutput, true)
		}

		const elapsed = Date.now() - lastCommandOutputEmitAt
		if (elapsed >= commandOutputStreamThrottleMs) {
			emitUpdate()
			return
		}

		if (!pendingCommandOutputEmitTimer) {
			pendingCommandOutputEmitTimer = setTimeout(emitUpdate, commandOutputStreamThrottleMs - elapsed)
		}
	}

	// Track when onCompleted callback finishes to avoid race condition.
	// The callback is async but Terminal/ExecaTerminal don't await it, so we track completion
	// explicitly to ensure persistedResult is set before we use it.
	let resolveOnCompleted: (() => void) | undefined
	const onCompletedPromise = new Promise<void>((resolve) => {
		resolveOnCompleted = resolve
	})

	const callbacks: RooTerminalCallbacks = {
		onLine: async (lines: string, process: RooTerminalProcess) => {
			accumulatedOutput += lines

			// Trim accumulated output to prevent unbounded memory growth
			if (accumulatedOutput.length > maxAccumulatedOutputSize) {
				accumulatedOutput = accumulatedOutput.slice(-maxAccumulatedOutputSize)
			}

			// Write to interceptor for persisted output
			interceptor?.write(lines)

			// Continue sending compressed output to webview for UI display (unchanged behavior)
			const compressedOutput = Terminal.compressTerminalOutput(accumulatedOutput)
			latestCompressedOutput = compressedOutput
			const status: CommandExecutionStatus = { executionId, status: "output", output: compressedOutput }
			void provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			schedulePartialCommandOutputUpdate()

			if (runInBackground || hasAskedForCommandOutput) {
				return
			}

			// Mark that we've asked to prevent multiple concurrent asks
			hasAskedForCommandOutput = true

			try {
				const { response, text, images } = await task.ask("command_output", "")
				runInBackground = true

				if (response === "messageResponse") {
					message = { text, images }
					process.continue()
				}
			} catch (_error) {
				// Silently handle ask errors (e.g., "Current ask promise was ignored")
			}
		},
		onCompleted: async (output: string | undefined) => {
			try {
				clearTimeout(pendingCommandOutputEmitTimer)
				pendingCommandOutputEmitTimer = undefined

				// Finalize interceptor and get persisted result.
				// We await finalize() to ensure the artifact file is fully flushed
				// before we advertise the artifact_id to the LLM.
				if (interceptor) {
					persistedResult = await interceptor.finalize()
				}

				// Continue using compressed output for UI display
				result = Terminal.compressTerminalOutput(output ?? "")
				latestCompressedOutput = result

				// Preserve order: wait for queued partial updates, then emit the final
				// non-partial command_output update.
				await commandOutputSayChain
				await queueCommandOutputMessage(result, false, true)
				completed = true
			} finally {
				// Signal that onCompleted has finished, so the main code can safely use persistedResult
				resolveOnCompleted?.()
			}
		},
		onShellExecutionStarted: (pid: number | undefined) => {
			const status: CommandExecutionStatus = { executionId, status: "started", pid, command: resolvedCommand }
			void provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
		},
		onShellExecutionComplete: (details: ExitCodeDetails) => {
			const status: CommandExecutionStatus = { executionId, status: "exited", exitCode: details.exitCode }
			void provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			exitDetails = details
		},
	}

	if (terminalProvider === "vscode") {
		callbacks.onNoShellIntegration = (error: string) => {
			TelemetryService.instance.captureShellIntegrationError(task.taskId)
			shellIntegrationError = error
		}
	}

	const terminal = await TerminalRegistry.getOrCreateTerminal(workingDir, task.taskId, terminalProvider)

	if (terminal instanceof Terminal) {
		terminal.terminal.show(true)

		// Update the working directory in case the terminal we asked for has
		// a different working directory so that the model will know where the
		// command actually executed.
		workingDir = terminal.getCurrentWorkingDirectory()
	}

	const process = terminal.runCommand(resolvedCommand, callbacks)
	task.terminalProcess = process

	// Track command execution for persistent shell session metrics
	if ("commandCount" in terminal) {
		;(terminal as Record<string, UnsafeAny>).commandCount++
	}

	// Dual-timeout logic:
	// - Agent timeout: transitions the command to background (continues running)
	// - User timeout: aborts the command (kills it)
	// Both timers run independently — the user timeout remains active as a safety net
	// even after the agent timeout moves the command to the background.
	let agentTimeoutId: NodeJS.Timeout | undefined
	let userTimeoutId: NodeJS.Timeout | undefined
	let isUserTimedOut = false

	try {
		const racers: Promise<void>[] = [process]

		// Agent timeout: transition to background (command keeps running)
		if (agentTimeout > 0) {
			racers.push(
				new Promise<void>((resolve) => {
					agentTimeoutId = setTimeout(() => {
						runInBackground = true
						process.continue()
						task.supersedePendingAsk()
						resolve()
					}, agentTimeout)
				}),
			)
		}

		// User timeout: abort the command (existing behavior)
		if (commandExecutionTimeout > 0) {
			racers.push(
				new Promise<void>((_, reject) => {
					userTimeoutId = setTimeout(() => {
						isUserTimedOut = true
						task.terminalProcess?.abort()
						reject(new Error(`Command execution timed out after ${commandExecutionTimeout}ms`))
					}, commandExecutionTimeout)
				}),
			)
		}

		await Promise.race(racers)
	} catch (error) {
		if (isUserTimedOut) {
			const status: CommandExecutionStatus = { executionId, status: "timeout" }
			void provider?.postMessageToWebview({ type: "commandExecutionStatus", text: JSON.stringify(status) })
			await task.say("error", t("common:errors:command_timeout", { seconds: commandExecutionTimeoutSeconds }))
			task.didToolFailInCurrentTurn = true
			task.terminalProcess = undefined

			return [
				false,
				`The command was terminated after exceeding a user-configured ${commandExecutionTimeoutSeconds}s timeout. Do not try to re-run the command.`,
			]
		}
		throw error
	} finally {
		clearTimeout(agentTimeoutId)
		clearTimeout(userTimeoutId)
		clearTimeout(pendingCommandOutputEmitTimer)
		task.terminalProcess = undefined
	}

	if (shellIntegrationError) {
		throw new ShellIntegrationError(shellIntegrationError)
	}

	// Wait for a short delay to ensure all messages are sent to the webview.
	// This delay allows time for non-awaited promises to be created and
	// for their associated messages to be sent to the webview, maintaining
	// the correct order of messages (although the webview is smart about
	// grouping command_output messages despite any gaps anyways).
	await delay(50)

	// Wait for onCompleted callback to finish if shell execution completed.
	// This ensures persistedResult is set before we try to use it, fixing the race
	// condition where exitDetails is set (sync) before the async onCompleted finishes.
	if (exitDetails && onCompletedPromise) {
		await onCompletedPromise
	}

	if (message) {
		const { text, images } = message
		await task.say("user_feedback", text, images)

		return [
			true,
			formatResponse.toolResult(
				[
					`Command is still running in terminal from '${terminal.getCurrentWorkingDirectory().toPosix()}'.`,
					result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
					`<user_message>\n${text}\n</user_message>`,
				].join("\n"),
				images,
			),
		]
	} else if (completed || exitDetails) {
		const currentWorkingDir = terminal.getCurrentWorkingDirectory().toPosix()

		// Use persisted output format when output was truncated and spilled to disk
		if (persistedResult?.truncated) {
			return [false, formatPersistedOutput(persistedResult, exitDetails, currentWorkingDir)]
		}

		// Use inline format for small outputs (original behavior with exit status)
		let exitStatus: string = ""

		if (exitDetails !== undefined) {
			if (exitDetails.signalName) {
				exitStatus = `Process terminated by signal ${exitDetails.signalName}`

				if (exitDetails.coreDumpPossible) {
					exitStatus += " - core dump possible"
				}
			} else if (exitDetails.exitCode === undefined) {
				result += "<VSCE exit code is undefined: terminal output and command execution status is UnsafeAny.>"
				exitStatus = `Exit code: <undefined, notify user>`
			} else {
				if (exitDetails.exitCode !== 0) {
					exitStatus += "Command execution was not successful, inspect the cause and adjust as needed.\n"
				}

				exitStatus += `Exit code: ${exitDetails.exitCode}`
			}
		} else {
			result += "<VSCE exitDetails == undefined: terminal output and command execution status is UnsafeAny.>"
			exitStatus = `Exit code: <undefined, notify user>`
		}

		let formattedResult = `Command executed in terminal within working directory '${currentWorkingDir}'. ${exitStatus}\nOutput:\n${result}`

		if (exitDetails?.exitCode !== undefined && exitDetails.exitCode !== 0) {
			const extensionPath = task.providerRef.deref()?.context.extensionPath
			if (/\b(cjpm|cjc)\b/i.test(resolvedCommand)) {
				const appendix = await buildCangjieExecuteCommandErrorAppendix(result, task.cwd, extensionPath)
				if (appendix) {
					formattedResult += appendix
				}
			}
		}

		return [false, formattedResult]
	} else {
		return [
			false,
			[
				`Command is still running in terminal ${workingDir ? ` from '${workingDir.toPosix()}'` : ""}.`,
				result.length > 0 ? `Here's the output so far:\n${result}\n` : "\n",
				"You will be updated on the terminal status and new output in the future.",
			].join("\n"),
		]
	}
}

/**
 * Format exit status from ExitCodeDetails
 */
function formatExitStatus(exitDetails: ExitCodeDetails | undefined): string {
	if (exitDetails === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	if (exitDetails.signalName) {
		let status = `Process terminated by signal ${exitDetails.signalName}`
		if (exitDetails.coreDumpPossible) {
			status += " - core dump possible"
		}
		return status
	}

	if (exitDetails.exitCode === undefined) {
		return "Exit code: <undefined, notify user>"
	}

	let status = ""
	if (exitDetails.exitCode !== 0) {
		status += "Command execution was not successful, inspect the cause and adjust as needed.\n"
	}
	status += `Exit code: ${exitDetails.exitCode}`
	return status
}

/**
 * Format persisted output result for tool response when output was truncated
 */
function formatPersistedOutput(
	result: PersistedCommandOutput,
	exitDetails: ExitCodeDetails | undefined,
	workingDir: string,
): string {
	const exitStatus = formatExitStatus(exitDetails)
	const sizeStr = formatBytes(result.totalBytes)
	const artifactId = result.artifactPath ? path.basename(result.artifactPath) : ""

	return [
		`Command executed in '${workingDir}'. ${exitStatus}`,
		"",
		`Output (${sizeStr}) persisted. Artifact ID: ${artifactId}`,
		"",
		"Preview:",
		result.preview,
		"",
		"Use read_command_output tool to view full output if needed.",
	].join("\n")
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

const HTTP_COMMAND_PATTERNS = [
	/\bcurl\s/i,
	/\bwget\s/i,
	/\bhttpie\b/i,
	/\bhttp\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\b/i,
	/\bInvoke-WebRequest\b/i,
	/\bInvoke-RestMethod\b/i,
	/\biwr\s/i,
	/\birm\s/i,
	/\bfetch\b.*https?:/i,
]

function isHttpCommand(command: string): boolean {
	return HTTP_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
}

export const executeCommandTool = new ExecuteCommandTool()
