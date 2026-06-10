import { z } from "zod"

import { BaseTool, type ToolCallbacks, type ValidationResult } from "./BaseTool"
import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"
import { ignoreAbortError } from "../../utils/errorHandling"

interface PowerShellParams {
	command: string
	cwd?: string
	timeout?: number
}

/**
 * @deprecated Use execute_command tool with powershell.exe directly. This tool
 * is deprecated because its Base64 encoding was incorrect (utf-8 instead of
 * utf16le) and it never actually executed commands — it only returned a
 * message. Removed from registry in registerAllTools.ts.
 *
 * PowerShellTool — execute PowerShell commands on Windows.
 *
 * Only available on Windows (process.platform === "win32").
 * Uses `powershell.exe -Command <command>` for execution.
 * Shares timeout and permission-check patterns with ExecuteCommandTool.
 *
 * Marked as shouldDefer = true, so it's only loaded when discovered via ToolSearchTool.
 */
export class PowerShellTool extends BaseTool<"execute_command"> {
	readonly name = "execute_command" as const
	override readonly maxResultSizeChars = 100_000

	/**
	 * Only available on Windows.
	 */
	override get shouldDefer(): boolean {
		return true
	}

	override get searchHint(): string {
		return "powershell windows command shell ps1 script"
	}

	protected override get inputSchema() {
		return z.object({
			command: z.string().min(1, "command is required"),
			cwd: z.string().optional(),
			timeout: z.number().optional(),
		})
	}

	override validateInput(params: PowerShellParams): ValidationResult {
		if (!params.command || params.command.trim() === "") {
			return { valid: false, error: "PowerShell command is required and cannot be empty." }
		}
		return { valid: true }
	}

	/**
	 * Check if this tool is available on the current platform.
	 */
	static isAvailable(): boolean {
		return process.platform === "win32"
	}

	async execute(params: PowerShellParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { command, cwd: _customCwd, timeout: _timeout } = params
		const { handleError, pushToolResult, askApproval } = callbacks

		try {
			// Wrap using -EncodedCommand (Base64) to prevent PowerShell metacharacter injection
			const encoded = Buffer.from(command, "utf-8").toString("base64")
			const psCommand = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`

			task.consecutiveMistakeCount = 0

			const didApprove = await askApproval("command", psCommand)
			if (!didApprove) {
				return
			}

			// Delegate to the standard command execution via task
			// The actual terminal execution is handled by the existing infrastructure
			pushToolResult(
				`PowerShell command prepared: ${psCommand}\n` +
					`Note: PowerShell execution delegates to the execute_command infrastructure. ` +
					`Use execute_command with the powershell.exe wrapper for actual execution.`,
			)
		} catch (error) {
			await handleError("executing PowerShell command", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"execute_command">): Promise<void> {
		const command = block.params.command
		await task.ask("command", `[PowerShell] ${command ?? ""}`).catch(ignoreAbortError)
	}
}

export const powerShellTool = new PowerShellTool()
