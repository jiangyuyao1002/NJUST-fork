import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { formatResponse } from "../prompts/responses"

interface TaskStopParams {
	taskId: string
	reason?: string
}

type TaskStopMode = "self_only" | "tree_only" | "admin"

function getTaskStopMode(): TaskStopMode {
	const raw = (process.env.ROO_TASK_STOP_MODE || "tree_only").toLowerCase()
	if (raw === "self_only" || raw === "tree_only" || raw === "admin") {
		return raw
	}
	return "tree_only"
}

export class TaskStopTool extends BaseTool<"task_stop"> {
	readonly name = "task_stop" as const

	override userFacingName(): string {
		return "Task Stop"
	}

	override async execute(params: TaskStopParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		if (!params.taskId) {
			pushToolResult(await task.sayAndCreateMissingParamError("task_stop", "taskId"))
			return
		}

		const provider = task.providerRef.deref() as UnsafeAny
		if (!provider?.getTaskWithId) {
			pushToolResult(formatResponse.toolError("Task provider is unavailable for task_stop."))
			return
		}

		try {
			const found = await provider.getTaskWithId(params.taskId)
			if (!found?.historyItem) {
				pushToolResult(formatResponse.toolError(`Task not found: ${params.taskId}`))
				return
			}

			const mode = getTaskStopMode()
			const targetRootTaskId = found.historyItem.rootTaskId || found.historyItem.id
			const callerRootTaskId = task.rootTaskId || task.taskId
			if (mode === "self_only" && params.taskId !== task.taskId) {
				pushToolResult(formatResponse.toolError("Permission denied: task_stop mode is self_only."))
				return
			}
			if (mode === "tree_only" && targetRootTaskId !== callerRootTaskId && params.taskId !== task.taskId) {
				pushToolResult(
					formatResponse.toolError(
						`Permission denied: task_stop can only stop tasks within the same delegation tree (caller root: ${callerRootTaskId}, target root: ${targetRootTaskId}).`,
					),
				)
				return
			}

			const runningTask = provider
				.getAllTaskInstances?.()
				?.find((t: Task) => t.taskId === params.taskId)

			if (!runningTask) {
				pushToolResult(`Task ${params.taskId} is not currently running (already stopped or completed).`)
				return
			}

			await runningTask.abortTask(true)
			pushToolResult(
				`Stopped task ${params.taskId}${params.reason ? ` (reason: ${params.reason})` : ""}.`,
			)
		} catch (error) {
			pushToolResult(formatResponse.toolError(`Failed to stop task ${params.taskId}: ${String(error)}`))
		}
	}
}

export const taskStopTool = new TaskStopTool()
