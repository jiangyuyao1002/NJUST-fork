import { z } from "zod"

import { Task } from "../task/Task"
import { TaskBoard } from "../task/TaskBoard"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface TaskGetParams {
	taskId: string
}

export class TaskGetTool extends BaseTool<"task_get"> {
	readonly name = "task_get" as const

	override userFacingName(): string {
		return "Task Get"
	}

	override isReadOnly(): boolean {
		return true
	}

	override isConcurrencySafe(): boolean {
		return true
	}

	protected override get inputSchema() {
		return z.object({
			taskId: z.string().min(1, "taskId is required"),
		})
	}

	override async execute(params: TaskGetParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const board = new TaskBoard(task.cwd, task.taskId)
			const found = await board.getTask(params.taskId)

			task.consecutiveMistakeCount = 0

			if (!found) {
				pushToolResult(formatResponse.toolError(`Task not found: ${params.taskId}`))
			} else {
				pushToolResult(
					`Task details:\n${JSON.stringify(found, null, 2)}`,
				)
			}
		} catch (error) {
			await handleError("getting task", error as Error)
		}
	}
}

export const taskGetTool = new TaskGetTool()
