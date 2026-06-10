import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"
import type { ClineAsk, ToolProgressStatus } from "@njust-ai/types"

import type { ToolResponse, McpToolUse, ToolUse, PushToolResultOptions } from "../../shared/tools"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { Task } from "../task/Task"
import { TaskState } from "../task/TaskStateMachine"
import { AskIgnoredError } from "../task/AskIgnoredError"
import { toolRegistry } from "../tools/ToolRegistry"
import { applyToolResultTokenBudget } from "./toolUseHelpers"

export async function handleMcpToolUseBlock(cline: Task, block: McpToolUse): Promise<void> {
	if (cline.didRejectTool) {
		const toolCallId = block.id
		const errorMessage = !block.partial
			? `Skipping MCP tool ${block.name} due to user rejecting a previous tool.`
			: `MCP tool ${block.name} was interrupted and not executed due to user rejecting a previous tool.`

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: errorMessage,
				is_error: true,
			})
		}
		return
	}

	let hasToolResult = false
	const toolCallId = block.id

	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse, second?: string[] | PushToolResultOptions) => {
		if (hasToolResult) {
			logger.warn(
				"PresentAssistantMessage",
				`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`,
			)
			return
		}
		const feedbackImages = Array.isArray(second) ? second : undefined
		const optErr = second && !Array.isArray(second) ? second : undefined

		let resultContent: string
		let imageBlocks: Anthropic.ImageBlockParam[] = []

		if (typeof content === "string") {
			resultContent = content || "(tool did not return anything)"
		} else {
			const textBlocks = content.filter((item) => item.type === "text")
			imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
			resultContent =
				textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
				"(tool did not return anything)"
		}

		if (approvalFeedback) {
			const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
			resultContent = `${feedbackText}\n\n${resultContent}`

			if (approvalFeedback.images) {
				const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
				imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
			}
		}

		if (feedbackImages && feedbackImages.length > 0) {
			const extra = formatResponse.imageBlocks(feedbackImages)
			imageBlocks = [...extra, ...imageBlocks]
		}

		resultContent = applyToolResultTokenBudget(cline, resultContent)

		if (toolCallId) {
			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: resultContent,
				is_error: optErr?.isError || undefined,
			})

			if (imageBlocks.length > 0) {
				cline.userMessageContent.push(...imageBlocks)
			}
		}

		hasToolResult = true
	}

	const _toolDescription = () => `[mcp_tool: ${block.serverName}/${block.toolName}]`

	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	) => {
		cline.forceTaskState(TaskState.WAITING_APPROVAL)
		const { response, text, images } = await cline.ask(
			type,
			partialMessage,
			false,
			progressStatus,
			isProtected || false,
		)

		if (response !== "yesButtonClicked") {
			if (text) {
				await cline.say("user_feedback", text, images)
				pushToolResult(formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images))
			} else {
				pushToolResult(formatResponse.toolDenied())
			}
			cline.didRejectTool = true
			return false
		}

		if (text) {
			await cline.say("user_feedback", text, images)
			approvalFeedback = { text, images }
		}

		cline.forceTaskState(TaskState.PROCESSING_TOOLS)
		return true
	}

	const handleError = async (action: string, error: Error) => {
		if (error instanceof AskIgnoredError) {
			return
		}
		const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
		await cline.say("error", `Error ${action}:\n${getErrorMessage(error)}`)
		pushToolResult(formatResponse.toolError(errorString))
	}

	if (!block.partial) {
		cline.recordToolUsage("use_mcp_tool")
	}

	const mcpHub = cline.providerRef.deref()?.getMcpHub()
	let resolvedServerName = block.serverName
	if (mcpHub) {
		const originalName = mcpHub.findServerNameBySanitizedName(block.serverName)
		if (originalName) {
			resolvedServerName = originalName
		}
	}

	const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
		type: "tool_use",
		id: block.id,
		name: "use_mcp_tool",
		params: {
			server_name: resolvedServerName,
			tool_name: block.toolName,
			arguments: JSON.stringify(block.arguments),
		},
		partial: block.partial,
		nativeArgs: {
			server_name: resolvedServerName,
			tool_name: block.toolName,
			arguments: block.arguments,
		},
	}

	await toolRegistry.get("use_mcp_tool")!.handle(cline, syntheticToolUse, {
		askApproval,
		handleError,
		pushToolResult,
	})
}
