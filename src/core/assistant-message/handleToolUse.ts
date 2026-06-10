import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"
import type { ToolName, ClineAsk, ToolProgressStatus } from "@njust-ai/types"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { customToolRegistry } from "@njust-ai/core"

import type { ToolResponse, ToolUse } from "../../shared/tools"
import { getErrorMessage, wrapAsError } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { t } from "../../i18n"
import { Task } from "../task/Task"
import { TaskState } from "../task/TaskStateMachine"
import { toolRegistry } from "../tools/ToolRegistry"
import { AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import type { ToolCallbacks } from "../tools/BaseTool"
import { AskIgnoredError } from "../task/AskIgnoredError"
import { defaultModeSlug } from "../../shared/modes"
import { isValidToolName } from "../tools/validateToolUse"
import type { TypedBlock } from "./types"
import {
	applyToolResultTokenBudget,
	buildToolDescription,
	validateToolUseBlock,
	checkToolRepetition,
	tryEagerBatch,
} from "./toolUseHelpers"

export type BlockHandlerResult = "break" | "continue"

async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		logger.error(
			"PresentAssistantMessage",
			`[Task#presentAssistantMessage] Error saving checkpoint: ${error instanceof Error ? getErrorMessage(error) : String(error)}`,
			error,
		)
		TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
	}
}

export async function handleToolUseBlock(cline: Task, block: ToolUse): Promise<BlockHandlerResult> {
	cline.forceTaskState(TaskState.PROCESSING_TOOLS)

	const eagerHandled = await tryEagerBatch(cline)
	if (eagerHandled) return "continue"

	const toolCallId = (block as UnsafeAny as TypedBlock).id as string | undefined
	if (!toolCallId) {
		const errorMessage =
			"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
		try {
			if (
				typeof (cline as Record<string, UnsafeAny>).recordToolError === "function" &&
				typeof (block as Record<string, UnsafeAny>).name === "string"
			) {
				;(cline as Record<string, UnsafeAny>).recordToolError(
					(block as Record<string, UnsafeAny>).name as ToolName,
					errorMessage,
				)
			}
		} catch (error) {
			logger.debug("ToolUse", "recordToolError failed", error)
		}
		cline.consecutiveMistakeCount++
		await cline.say("error", errorMessage)
		cline.userMessageContent.push({ type: "text", text: errorMessage })
		cline.didAlreadyUseTool = true
		return "break"
	}

	const existingToolResult = cline.userMessageContent.find(
		(content): content is Anthropic.ToolResultBlockParam =>
			content.type === "tool_result" && content.tool_use_id === sanitizeToolUseId(toolCallId),
	)
	if (existingToolResult) {
		return "break"
	}

	const state = await cline.providerRef.deref()?.getState()
	const { mode, customModes, experiments: stateExperiments, disabledTools } = state ?? {}
	const allowedTools = cline.allowedTools ? Array.from(cline.allowedTools) : undefined

	const toolDescription = () => buildToolDescription(block, customModes)

	if (cline.didRejectTool) {
		const errorMessage = !block.partial
			? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
			: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: errorMessage,
			is_error: true,
		})

		return "break"
	}

	let hasToolResult = false

	if (!block.partial) {
		const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined
		const isKnownTool = isValidToolName(String(block.name), stateExperiments)
		if (isKnownTool && !block.nativeArgs && !customTool) {
			const errorMessage =
				`Invalid tool call for '${block.name}': missing nativeArgs. ` +
				`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`

			cline.consecutiveMistakeCount++
			try {
				cline.recordToolError(block.name as ToolName, errorMessage)
			} catch (error) {
				logger.debug("ToolUse", "recordToolError failed", error)
			}

			cline.pushToolResultToUserContent({
				type: "tool_result",
				tool_use_id: sanitizeToolUseId(toolCallId),
				content: formatResponse.toolError(errorMessage),
				is_error: true,
			})

			return "break"
		}
	}

	let approvalFeedback: { text: string; images?: string[] } | undefined

	const pushToolResult = (content: ToolResponse) => {
		if (hasToolResult) {
			logger.warn(
				"PresentAssistantMessage",
				`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`,
			)
			return
		}

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

		resultContent = applyToolResultTokenBudget(cline, resultContent)

		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: resultContent,
		})

		if (imageBlocks.length > 0) {
			cline.userMessageContent.push(...imageBlocks)
		}

		hasToolResult = true
	}

	const askApproval = async (
		type: ClineAsk,
		partialMessage?: string,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	) => {
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

	const askFinishSubTaskApproval = async () => {
		const toolMessage = JSON.stringify({ tool: "finishTask" })
		return await askApproval("tool", toolMessage)
	}

	const handleError = async (action: string, error: Error) => {
		if (error instanceof AskIgnoredError) {
			return
		}
		const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

		await cline.say("error", `Error ${action}:\n${getErrorMessage(error)}`)

		pushToolResult(formatResponse.toolError(errorString))
	}
	const reportProgress: ToolCallbacks["reportProgress"] = async (status) => {
		await cline
			.ask("tool", JSON.stringify({ tool: "progress", text: status?.text }), true, status)
			.catch(() => undefined)
	}

	if (!block.partial) {
		const isCustomTool = stateExperiments?.customTools && customToolRegistry.has(block.name)
		const recordName = isCustomTool ? "custom_tool" : block.name
		cline.recordToolUsage(recordName)

		if (block.name === "read_file" && block.usedLegacyFormat) {
			cline.api.getModel()
		}
	}

	const valid = await validateToolUseBlock(
		cline,
		block,
		toolCallId,
		mode,
		customModes,
		stateExperiments,
		disabledTools,
		allowedTools,
	)
	if (!valid) return "break"

	const proceed = await checkToolRepetition(cline, block, pushToolResult)
	if (!proceed) return "break"

	{
		const tool = toolRegistry.get(block.name)
		if (tool) {
			if (tool.requiresCheckpoint) {
				await checkpointSaveAndMark(cline)
			}

			let effectiveCallbacks: ToolCallbacks | AttemptCompletionCallbacks
			if (block.name === "attempt_completion") {
				effectiveCallbacks = {
					askApproval,
					handleError,
					pushToolResult,
					askFinishSubTaskApproval,
					toolDescription,
				} as AttemptCompletionCallbacks
			} else {
				effectiveCallbacks = {
					askApproval,
					handleError,
					pushToolResult,
					reportProgress,
					toolCallId: block.id,
				}
			}

			try {
				await tool.handle(cline, block as ToolUse, effectiveCallbacks)
			} catch (err) {
				logger.error(
					"PresentAssistantMessage",
					`[presentAssistantMessage] Tool ${block.name} failed after retries:`,
					getErrorMessage(err),
				)
				TelemetryService.reportError(err, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
				pushToolResult(formatResponse.toolError(`Tool ${block.name} failed: ${getErrorMessage(err)}`))
			}
		} else {
			if (!block.partial) {
				const customTool = stateExperiments?.customTools ? customToolRegistry.get(block.name) : undefined

				if (customTool) {
					try {
						let customToolArgs

						if (customTool.parameters) {
							try {
								customToolArgs = customTool.parameters.parse(block.nativeArgs || block.params || {})
							} catch (parseParamsError: unknown) {
								const message = `Custom tool "${block.name}" argument validation failed: ${getErrorMessage(parseParamsError)}`
								logger.error("PresentAssistantMessage", message)
								TelemetryService.reportError(
									parseParamsError,
									TelemetryEventName.ASSISTANT_MESSAGE_ERROR,
								)
								cline.consecutiveMistakeCount++
								await cline.say("error", message)
								pushToolResult(formatResponse.toolError(message))
							}
						}

						if (customToolArgs !== undefined || !customTool.parameters) {
							const result = await customTool.execute(customToolArgs, {
								mode: mode ?? defaultModeSlug,
								task: cline,
							})

							logger.info(
								"PresentAssistantMessage",
								`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`,
							)

							pushToolResult(result)
							cline.consecutiveMistakeCount = 0
						}
					} catch (executionError: unknown) {
						cline.consecutiveMistakeCount++
						cline.recordToolError("custom_tool", getErrorMessage(executionError))
						TelemetryService.reportError(executionError, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
						await handleError(`executing custom tool "${block.name}"`, wrapAsError(executionError))
					}
				} else {
					const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
					cline.consecutiveMistakeCount++
					cline.recordToolError(block.name as ToolName, errorMessage)
					await cline.say("error", t("tools:unknownToolError", { toolName: block.name }))
					cline.pushToolResultToUserContent({
						type: "tool_result",
						tool_use_id: sanitizeToolUseId(toolCallId),
						content: formatResponse.toolError(errorMessage),
						is_error: true,
					})
				}
			}
		}
	}

	return "break"
}
