import { z } from "zod"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { ignoreAbortError } from "../../utils/errorHandling"

interface SendMessageToolParams {
	targetTaskId: string
	message: string
}

export class SendMessageTool extends BaseTool<"send_message"> {
	readonly name = "send_message" as const

	override userFacingName(): string {
		return "Send Message"
	}

	override get searchHint(): string {
		return "send message communicate agent"
	}

	override isReadOnly(): boolean {
		return false
	}

	protected override get inputSchema() {
		return z.object({
			targetTaskId: z.string().min(1, "targetTaskId is required"),
			message: z.string().min(1, "message is required"),
		})
	}

	async execute(params: SendMessageToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { targetTaskId, message } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {

			// Get the provider to find the target task
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Validate target task is not self
			if (targetTaskId === task.taskId) {
				pushToolResult(
					formatResponse.toolError("Cannot send a message to yourself. Specify a different targetTaskId."),
				)
				return
			}

			// Find the target task in the provider's task stack
			const targetTask = (provider as Record<string, UnsafeAny>).findTaskInStack(targetTaskId) as Task | undefined

			if (!targetTask) {
				pushToolResult(
					formatResponse.toolError(
						`Target task "${targetTaskId}" not found in the active task stack. ` +
							`The task may have already completed or does not exist. ` +
							`Active tasks: ${(provider as Record<string, UnsafeAny>).getCurrentTaskStack().join(", ")}`,
					),
				)
				return
			}

			// Check if target task is aborted or abandoned
			if (targetTask.abort || (targetTask as Record<string, UnsafeAny>).abandoned) {
				pushToolResult(
					formatResponse.toolError(
						`Target task "${targetTaskId}" has already been completed or aborted. Cannot send messages to it.`,
					),
				)
				return
			}

			// Validate relationship: only allow sending to parent or child tasks
			const isParent = task.parentTaskId === targetTaskId
			const isChild = targetTask.parentTaskId === task.taskId
			const isSibling =
				task.parentTaskId !== undefined &&
				targetTask.parentTaskId !== undefined &&
				task.parentTaskId === targetTask.parentTaskId

			if (!isParent && !isChild && !isSibling) {
				pushToolResult(
					formatResponse.toolError(
						`Cannot send message to task "${targetTaskId}": it is not a parent, child, or sibling task. ` +
							`Messages can only be sent between related tasks in the hierarchy.`,
					),
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// Build approval message
			const relationLabel = isParent ? "parent" : isChild ? "child" : "sibling"
			const toolMessage = JSON.stringify({
				tool: "send_message",
				targetTaskId,
				relation: relationLabel,
				content: message,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Inject the message into the target task's message queue.
			// The message is prefixed with metadata so the target agent knows who sent it.
			const formattedMessage = [
				`[Inter-Agent Message]`,
				`From: Task ${task.taskId} (${relationLabel === "parent" ? "child" : relationLabel === "child" ? "parent" : "sibling"})`,
				``,
				message,
			].join("\n")

			targetTask.messageQueueService.addMessage(formattedMessage)

			pushToolResult(
				`Message sent to ${relationLabel} task "${targetTaskId}" successfully. ` +
					`The message has been queued and will be delivered when the target task processes its next message.`,
			)
		} catch (error) {
			await handleError("sending message to agent", error instanceof Error ? error : new Error(String(error)))}
	}

	override async handlePartial(task: Task, block: ToolUse<"send_message">): Promise<void> {
		const nativeArgs = block.nativeArgs as SendMessageToolParams | undefined
		const targetTaskId: string | undefined = nativeArgs?.targetTaskId
		const message: string | undefined = nativeArgs?.message

		const partialMessage = JSON.stringify({
			tool: "send_message",
			targetTaskId: targetTaskId ?? "",
			content: message ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const sendMessageTool = new SendMessageTool()
