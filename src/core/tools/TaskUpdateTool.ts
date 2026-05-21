import { z } from "zod"

import { Task } from "../task/Task"
import { TaskBoard, type TaskBoardItem } from "../task/TaskBoard"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface TaskUpdateParams {
	taskId: string
	status?: "completed" | "pending" | "in_progress" | "failed"
	title?: string
	description?: string
	priority?: "high" | "medium" | "low"
}

export class TaskUpdateTool extends BaseTool<"task_update"> {
	readonly name = "task_update" as const

	override userFacingName(): string {
		return "Task Update"
	}

	protected override get inputSchema() {
		return z.object({
			taskId: z.string().min(1, "taskId is required"),
			status: z.enum(["completed", "pending", "in_progress", "failed"]).optional(),
			title: z.string().optional(),
			description: z.string().optional(),
			priority: z.enum(["high", "medium", "low"]).optional(),
		})
	}

	override async execute(params: TaskUpdateParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const board = new TaskBoard(task.cwd, task.taskId)

			const updates: Partial<Pick<TaskBoardItem, "title" | "description" | "status" | "priority">> = {}
			if (params.status) updates.status = params.status
			if (params.title) updates.title = params.title
			if (params.description) updates.description = params.description
			if (params.priority) updates.priority = params.priority

			const updated = await board.updateTask(params.taskId, updates)

			task.consecutiveMistakeCount = 0
			pushToolResult(
				`Task updated successfully:\n${JSON.stringify(updated, null, 2)}`,
			)
		} catch (error) {
			await handleError("updating task", error as Error)
		}
	}
}

export const taskUpdateTool = new TaskUpdateTool()
