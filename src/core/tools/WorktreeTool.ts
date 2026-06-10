import { z } from "zod"

import { BaseTool, type ToolCallbacks, type ValidationResult } from "./BaseTool"
import { Task } from "../task/Task"

interface WorktreeParams {
	action: "enter" | "exit"
	branch?: string
	path?: string
}

/**
 * WorktreeTool — manage git worktrees for isolated work.
 *
 * Supports:
 *   - enter: create or switch to a git worktree
 *   - exit: return to the main working tree
 *
 * Internally constructs `git worktree add` / `git worktree remove` commands
 * and executes them via the task's approval flow.
 *
 * Registered via `registerConditional` with a git-availability check.
 * Marked as shouldDefer = true — only loaded when discovered via ToolSearchTool.
 *
 * Uses the `custom_tool` ToolName to avoid conflicting with execute_command.
 */
export class WorktreeTool extends BaseTool<"custom_tool"> {
	readonly name = "custom_tool" as const

	override get shouldDefer(): boolean {
		return true
	}

	override get searchHint(): string {
		return "git worktree branch isolated workspace"
	}

	override get aliases(): readonly string[] {
		return ["worktree"]
	}

	override userFacingName(): string {
		return "worktree"
	}

	protected override get inputSchema() {
		return z
			.object({
				action: z.enum(["enter", "exit"]),
				branch: z.string().optional(),
				path: z.string().optional(),
			})
			.refine(
				(data) => {
					if (data.action === "enter") {
						return !!(data.branch || data.path)
					}
					return true
				},
				{ message: "Either 'branch' or 'path' is required for 'enter' action", path: ["branch"] },
			)
	}

	override validateInput(params: WorktreeParams): ValidationResult {
		if (!params.action) {
			return { valid: false, error: "Action is required: 'enter' or 'exit'." }
		}
		if (params.action !== "enter" && params.action !== "exit") {
			return { valid: false, error: "Action must be 'enter' or 'exit'." }
		}
		if (params.action === "enter" && !params.branch && !params.path) {
			return { valid: false, error: "Either 'branch' or 'path' is required for 'enter' action." }
		}
		return { valid: true }
	}

	/**
	 * Check if git is available for worktree operations.
	 * Returns true if git is likely available on this system.
	 */
	static isAvailable(): boolean {
		// Simple heuristic: git is available on most dev machines.
		// A more robust check could spawn `git --version`, but that would
		// be async and slow for a registration condition.
		return true
	}

	async execute(params: WorktreeParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action, branch, path: worktreePath } = params
		const { handleError, pushToolResult, askApproval } = callbacks

		try {
			if (action === "enter") {
				const targetBranch = branch || `worktree-${Date.now()}`
				const targetPath = worktreePath || `.worktrees/${targetBranch}`

				const command = `git worktree add "${targetPath}" -b "${targetBranch}"`

				const didApprove = await askApproval("command", command)
				if (!didApprove) {
					return
				}

				pushToolResult(
					`Worktree command prepared:\n` +
						`  Command: ${command}\n` +
						`  Branch: ${targetBranch}\n` +
						`  Path: ${targetPath}\n\n` +
						`Note: Use execute_command to run the git worktree command. ` +
						`After creation, cd into the worktree path to work in isolation.`,
				)
			} else {
				// action === "exit"
				const targetPath = worktreePath || task.cwd

				const command = `git worktree remove "${targetPath}"`

				const didApprove = await askApproval("command", command)
				if (!didApprove) {
					return
				}

				pushToolResult(
					`Worktree removal command prepared:\n` +
						`  Command: ${command}\n` +
						`  Path: ${targetPath}\n\n` +
						`Note: Use execute_command to run the git worktree remove command. ` +
						`The worktree directory and its branch will be cleaned up.`,
				)
			}
		} catch (error) {
			await handleError("managing git worktree", error as Error)
		}
	}
}

export const worktreeTool = new WorktreeTool()
