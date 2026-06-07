import * as vscode from "vscode"
import { z } from "zod"

import { NJUST_AIEventName, type HistoryItem, TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import { Task } from "../task/Task"
import { ignoreAbortError } from "../../utils/errorHandling"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"
import type { TaskResult } from "../task/SubTaskOptions"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { logger } from "../../shared/logger"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	protected override get inputSchema() {
		return z.object({
			result: z.string().min(1, "result is required"),
		})
	}

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval } = callbacks

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList?.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		if (task.taskMode === "cangjie") {
			const cangjieBlockReason = task.cangjieRuntimePolicy.getAttemptCompletionBlockReason()
			if (cangjieBlockReason) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion", cangjieBlockReason)
				pushToolResult(formatResponse.toolError(cangjieBlockReason))
				return
			}
		}

		try {
			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			// Check for subtask using parentTaskId (metadata-driven delegation)
			if (task.parentTaskId) {
				// Check if this subtask has already completed and returned to parent
				// to prevent duplicate tool_results when user revisits from history
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (provider) {
					try {
						const { historyItem } = await provider.getTaskWithId(task.taskId)
						const status = historyItem?.status

						if (status === "completed") {
							// Subtask already completed - skip delegation flow entirely
							// Fall through to normal completion ask flow below (outside this if block)
							// This shows the user the completion result and waits for acceptance
							// without injecting another tool_result to the parent
						} else if (status === "active") {
							// Normal subtask completion - do delegation
							const delegation = await this.delegateToParent(
								task,
								result,
								provider,
								askFinishSubTaskApproval,
								pushToolResult,
							)
							if (delegation === "delegated") {
								this.emitTaskCompleted(task)
							}
							if (delegation !== "continue") return
						} else {
							// Unexpected status (undefined or "delegated") - log error and skip delegation
							// undefined indicates a bug in status persistence during child creation
							// "delegated" would mean this child has its own grandchild pending (shouldn't reach attempt_completion)
							logger.error(
								"AttemptCompletionTool",
								`Unexpected child task status "${status}" for task ${task.taskId}. Expected "active" or "completed". Skipping delegation to prevent data corruption.`,
							)
							// Fall through to normal completion ask flow
						}
					} catch (err) {
						// If we can't get the history, log error and skip delegation
						logger.error(
							"AttemptCompletionTool",
							`Failed to get history for task ${task.taskId}: ${(err as Error)?.message ?? String(err)}. Skipping delegation.`,
						)
						TelemetryService.reportError(
							err instanceof Error ? err : new Error(String(err)),
							TelemetryEventName.UTILITY_ERROR,
						)
						// Fall through to normal completion ask flow
					}
				}
			}

			// MemRL: the agent has declared the task done by invoking attempt_completion.
			// Record this as the success signal regardless of the user's approval action.
			task.markAttemptedCompletion()

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				this.emitTaskCompleted(task)
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			const feedbackText = `[USER-MESSAGE]\n${text}\n[END USER-MESSAGE]`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("completing task", error as Error)
		}
	}

	/**
	 * Handles the common delegation flow when a subtask completes.
	 * Returns:
	 * - "delegated" when completion was approved and parent resumed
	 * - "denied" when user denied finishing the subtask
	 * - "continue" when caller should fall through to normal completion ask flow
	 */
	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue"> {
		const didApprove = await askFinishSubTaskApproval()

		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		pushToolResult("")

		// For forked tasks, build a structured result summary with file info
		let completionResultSummary = result
		if (task.isolationLevel === "forked") {
			const taskResult: TaskResult = {
				success: true,
				summary: result,
				isolationLevel: "forked",
			}
			completionResultSummary = `[Forked Sub-task Result]\n${JSON.stringify(taskResult, null, 2)}`
		}

		await provider.reopenParentFromDelegation({
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			completionResultSummary,
		})

		return "delegated"
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(ignoreAbortError)
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(ignoreAbortError)
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	private emitTaskCompleted(task: Task): void {
		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		TelemetryService.instance.captureTaskCompleted(task.taskId)
		task.emit(NJUST_AIEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage, {
			isSubtask: !!task.parentTaskId,
		})

		// Signal the outer loop to stop re-prompting the model with
		// noToolsUsed() after the user accepts this completion.
		task.markTaskCompleted()
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
