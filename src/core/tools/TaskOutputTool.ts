import { z } from "zod"

import { readTaskMessages } from "../task-persistence"
import { Task } from "../task/Task"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { formatResponse } from "../prompts/responses"

interface TaskOutputParams {
	taskId: string
	offset?: number
	limit?: number
}

export class TaskOutputTool extends BaseTool<"task_output"> {
	readonly name = "task_output" as const

	override userFacingName(): string {
		return "Task Output"
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
			offset: z.number().int().nonnegative().optional(),
			limit: z.number().int().positive().optional(),
		})
	}

	override async execute(params: TaskOutputParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		try {
			const messages = await readTaskMessages({
				taskId: params.taskId,
				globalStoragePath: task.globalStoragePath,
			})
			const start = Math.max(0, params.offset ?? 0)
			const lim = Math.max(1, Math.min(200, params.limit ?? 50))
			const sliced = messages.slice(start, start + lim)
			pushToolResult(
				JSON.stringify(
					{
						taskId: params.taskId,
						offset: start,
						limit: lim,
						returned: sliced.length,
						hasMore: start + lim < messages.length,
						items: sliced,
					},
					null,
					2,
				),
			)
		} catch (error) {
			pushToolResult(
				formatResponse.toolError(`Failed to read task output for ${params.taskId}: ${String(error)}`),
			)
		}
	}
}

export const taskOutputTool = new TaskOutputTool()
