import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import type { ToolUse, McpToolUse } from "../../shared/tools"
import { logger } from "../../shared/logger"
import { Task } from "../task/Task"

import "../tools/registerAllTools"
import { sanitizeXmlToolCalls, parseXmlToolCalls } from "./sanitizeXmlToolCalls"
import { markUserContentReadyIfDrained } from "./streamState"
import type { AssistantMessageContent } from "./types"
import { handleMcpToolUseBlock } from "./handleMcpToolUse"
import { handleToolUseBlock } from "./handleToolUse"

export { markUserContentReadyIfDrained } from "./streamState"

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false
	const _lockAcquiredAt = performance.now()

	try {
		while (true) {
			if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
				markUserContentReadyIfDrained(cline)

				break
			}

			let block: AssistantMessageContent
			try {
				block = {
					...cline.assistantMessageContent[cline.currentStreamingContentIndex],
				} as AssistantMessageContent
			} catch (error) {
				logger.error("PresentAssistantMessage", "ERROR cloning block:", error)
				logger.error(
					"PresentAssistantMessage",
					`Block content:`,
					JSON.stringify(cline.assistantMessageContent[cline.currentStreamingContentIndex], null, 2),
				)
				TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
				cline.presentAssistantMessageLocked = false
				return
			}

			switch (block.type) {
				case "mcp_tool_use": {
					await handleMcpToolUseBlock(cline, block as McpToolUse)
					break
				}
				case "text": {
					if (cline.didRejectTool || cline.didAlreadyUseTool) {
						break
					}

					let content = block.content

					if (content) {
						content = content.replace(/<thinking>\s?/g, "")
						content = content.replace(/\s?<\/thinking>/g, "")

						const parsed = parseXmlToolCalls(content)
						if (parsed.hadXmlToolCalls) {
							content = parsed.content

							if (parsed.parsedToolCalls.length > 0) {
								for (const toolCall of parsed.parsedToolCalls) {
									cline.assistantMessageContent.push(toolCall as AssistantMessageContent)
								}

								const guidance =
									"[System: XML tool calls were detected and converted to native tool calls. " +
									"Please use native tool calling (the tool_calls API field) in future responses " +
									"instead of emitting XML markup in text content.]"
								cline.userMessageContent.push({ type: "text", text: guidance })
								logger.warn(
									"PresentAssistantMessage",
									`Converted ${parsed.parsedToolCalls.length} XML tool call(s) to native format`,
								)
							} else {
								const sanitized = sanitizeXmlToolCalls(content)
								if (sanitized.hadXmlToolCalls) {
									content = sanitized.content
								}
								const xmlToolCallError =
									"XML tool calls are not supported. " +
									"Use native tool calling (the tool_calls API field) instead of " +
									"emitting XML markup in text content. " +
									"The XML tool call markup has been stripped from this response."
								cline.consecutiveMistakeCount++
								await cline.say("error", xmlToolCallError)
								cline.userMessageContent.push({ type: "text", text: xmlToolCallError })
								logger.warn(
									"PresentAssistantMessage",
									"Stripped unparseable XML tool call markup from text block",
								)
							}
						}
					}

					await cline.say("text", content, undefined, block.partial)
					break
				}
				case "tool_use": {
					const result = await handleToolUseBlock(cline, block as ToolUse)
					if (result === "continue") continue
					break
				}
			}

			if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
				if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
					cline.userMessageContentReady = true
				}

				cline.currentStreamingContentIndex++

				if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
					continue
				} else {
					markUserContentReadyIfDrained(cline)
					break
				}
			}

			if (cline.presentAssistantMessageHasPendingUpdates) {
				cline.presentAssistantMessageHasPendingUpdates = false
				continue
			}

			break
		}

		const _lockHeldMs = performance.now() - _lockAcquiredAt
		if (_lockHeldMs > 5_000) {
			logger.warn(
				"PresentAssistantMessage",
				`[presentAssistantMessage] Lock held for ${_lockHeldMs.toFixed(0)}ms ` +
					`(task=${cline.taskId}, blockIndex=${cline.currentStreamingContentIndex})`,
			)
		}
	} finally {
		cline.presentAssistantMessageLocked = false
	}
}
