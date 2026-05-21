import { z } from "zod"

import { Task } from "../task/Task"
import { TaskBoard, type TaskFilter } from "../task/TaskBoard"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface TaskListParams {
	status?: "completed" | "pending" | "in_progress" | "failed"
	priority?: "high" | "medium" | "low"
	limit?: number
}

export class TaskListTool extends BaseTool<"task_list"> {
	readonly name = "task_list" as const

	override userFacingName(): string {
		return "Task List"
	}

	override isReadOnly(): boolean {
		return true
	}

	override isConcurrencySafe(): boolean {
		return true
	}

	protected override get inputSchema() {
		return z.object({
			status: z.enum(["completed", "pending", "in_progress", "failed"]).optional(),
			priority: z.enum(["high", "medium", "low"]).optional(),
			limit: z.number().int().positive().optional(),
		})
	}

	override async execute(params: TaskListParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const board = new TaskBoard(task.cwd, task.taskId)

			const filter: TaskFilter = {}
			if (params.status) filter.status = params.status
			if (params.priority) filter.priority = params.priority
			if (params.limit) filter.limit = params.limit

			const tasks = await board.listTasks(filter)

			task.consecutiveMistakeCount = 0

			if (tasks.length === 0) {
				pushToolResult("No tasks found matching the given filters.")
			} else {
				pushToolResult(
					`Found ${tasks.length} task(s):\n${JSON.stringify(tasks, null, 2)}`,
				)
			}
		} catch (error) {
			await handleError("listing tasks", error as Error)
		}
	}
}

export const taskListTool = new TaskListTool()
