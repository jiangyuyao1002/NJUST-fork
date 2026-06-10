import { z } from "zod"

import { Task } from "../task/Task"
import { TaskBoard, type CreateTaskParams, type TaskBoardItem } from "../task/TaskBoard"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface TaskCreateParams {
	title: string
	description?: string
	priority?: "high" | "medium" | "low"
	dependsOn?: string[]
}

export class TaskCreateTool extends BaseTool<"task_create"> {
	readonly name = "task_create" as const

	override userFacingName(): string {
		return "Task Create"
	}

	protected override get inputSchema() {
		return z.object({
			title: z.string().min(1, "title is required"),
			description: z.string().optional(),
			priority: z.enum(["high", "medium", "low"]).optional(),
			dependsOn: z.array(z.string()).optional(),
		})
	}

	override async execute(params: TaskCreateParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const board = new TaskBoard(task.cwd, task.taskId)

			const createParams: CreateTaskParams = {
				title: params.title,
				description: params.description ?? undefined,
				priority: params.priority ?? undefined,
				dependsOn: params.dependsOn ?? undefined,
			}

			const created: TaskBoardItem = await board.createTask(createParams)

			task.consecutiveMistakeCount = 0
			pushToolResult(`Task created successfully:\n${JSON.stringify(created, null, 2)}`)
		} catch (error) {
			await handleError("creating task", error as Error)
		}
	}
}

export const taskCreateTool = new TaskCreateTool()
