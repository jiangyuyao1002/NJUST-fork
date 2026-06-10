import type { GroundingSource } from "../../api/transform/stream"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"
import type { ToolUse, McpToolUse } from "../../shared/tools"
import type { ToolName } from "@njust-ai/types"

import { globalQueryProfiler } from "../../utils/queryProfiler"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"

type FinalizeToolUse = (task: TaskExecutorHost, id: string, finalToolUse: ToolUse | McpToolUse) => ToolUse | McpToolUse

export interface ProcessTaskStreamChunkOptions {
	task: TaskExecutorHost
	chunk: UnsafeAny
	toolCallParser: NativeToolCallParser
	requestProfileId: string
	pendingGroundingSources: GroundingSource[]
	finalizeToolUse: FinalizeToolUse
	appendReasoningText(text: string): string
	appendAssistantText(text: string): string
	addUsage(chunk: UnsafeAny): void
}

function presentAssistantMessage(task: TaskExecutorHost): void {
	void task.presentAssistantMessage().catch((error) => {
		logger.error("presentAssistantMessage failed", error)
		TelemetryService.reportError(
			error instanceof Error ? error : new Error(String(error)),
			TelemetryEventName.UTILITY_ERROR,
		)
	})
}

async function maybeEagerExecuteFinalTool(
	task: TaskExecutorHost,
	finalToolUse: ToolUse | McpToolUse,
): Promise<boolean> {
	if (finalToolUse?.type !== "tool_use") {
		return false
	}

	const state = await task.hostRef.deref()?.getState()
	const enabled = state?.enableStreamingToolExecution !== false
	if (!enabled || !(state?.autoApprovalEnabled ?? false)) {
		return false
	}

	const decision = task.toolExecution.streamingExecutor.shouldEagerExecute(task, finalToolUse)
	if (decision === "eager") {
		presentAssistantMessage(task)
		return true
	}

	return false
}

async function handleFinalToolCall(
	task: TaskExecutorHost,
	toolCallParser: NativeToolCallParser,
	finalizeToolUse: FinalizeToolUse,
	id: string,
): Promise<void> {
	const finalToolUse = toolCallParser.finalizeStreamingToolCall(id)
	const toolUseIndex = task.streamingToolCallIndices.get(id)

	if (finalToolUse) {
		const latest = finalizeToolUse(task, id, finalToolUse)
		if (await maybeEagerExecuteFinalTool(task, latest)) {
			return
		}

		presentAssistantMessage(task)
		return
	}

	if (toolUseIndex === undefined) {
		return
	}

	const existingToolUse = task.assistantMessageContent[toolUseIndex]
	if (existingToolUse && existingToolUse.type === "tool_use") {
		existingToolUse.partial = false
		existingToolUse.id = id
	}

	task.streamingToolCallIndices.delete(id)
	task.userMessageContentReady = false
	presentAssistantMessage(task)
}

export async function processTaskStreamChunk(options: ProcessTaskStreamChunkOptions): Promise<void> {
	const {
		task,
		chunk,
		toolCallParser,
		requestProfileId,
		pendingGroundingSources,
		finalizeToolUse,
		appendReasoningText,
		appendAssistantText,
		addUsage,
	} = options

	switch (chunk.type) {
		case "reasoning": {
			const reasoningMessage = appendReasoningText(chunk.text)
			let formattedReasoning = reasoningMessage
			if (reasoningMessage.includes("**")) {
				formattedReasoning = reasoningMessage.replace(/([.!?])\*\*([^*\n]+)\*\*/g, "$1\n\n**$2**")
			}
			await task.say("reasoning", formattedReasoning, undefined, true)
			break
		}
		case "usage":
			addUsage(chunk)
			break
		case "grounding":
			if (chunk.sources && chunk.sources.length > 0) {
				pendingGroundingSources.push(...chunk.sources)
			}
			break
		case "tool_call_partial": {
			const events = toolCallParser.processRawChunk({
				index: chunk.index,
				id: chunk.id,
				name: chunk.name,
				arguments: chunk.arguments,
			})

			for (const event of events) {
				if (event.type === "tool_call_start") {
					if (task.streamingToolCallIndices.has(event.id)) {
						logger.warn(
							"TaskExecutor",
							`Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name}) on task ${task.taskId}`,
						)
						continue
					}

					toolCallParser.startStreamingToolCall(event.id, event.name as ToolName)
					const lastBlock = task.assistantMessageContent[task.assistantMessageContent.length - 1]
					if (lastBlock?.type === "text" && lastBlock.partial) {
						lastBlock.partial = false
					}

					const toolUseIndex = task.assistantMessageContent.length
					task.streamingToolCallIndices.set(event.id, toolUseIndex)

					const partialToolUse: ToolUse = {
						type: "tool_use",
						name: event.name as ToolName,
						params: {},
						partial: true,
					}
					partialToolUse.id = event.id

					task.assistantMessageContent.push(partialToolUse)
					task.userMessageContentReady = false
					presentAssistantMessage(task)
				} else if (event.type === "tool_call_delta") {
					const partialToolUse = toolCallParser.processStreamingChunk(event.id, event.delta)
					if (!partialToolUse) {
						continue
					}

					const toolUseIndex = task.streamingToolCallIndices.get(event.id)
					if (toolUseIndex !== undefined) {
						partialToolUse.id = event.id
						task.assistantMessageContent[toolUseIndex] = partialToolUse
						presentAssistantMessage(task)
					}
				} else if (event.type === "tool_call_end") {
					await handleFinalToolCall(task, toolCallParser, finalizeToolUse, event.id)
				}
			}
			break
		}
		case "tool_call_end":
			await handleFinalToolCall(task, toolCallParser, finalizeToolUse, chunk.id)
			break
		case "tool_call": {
			const toolUse = NativeToolCallParser.parseToolCall({
				id: chunk.id,
				name: chunk.name as ToolName,
				arguments: chunk.arguments,
			})

			if (!toolUse) {
				logger.error("TaskExecutor", `Failed to parse tool call for task ${task.taskId}:`, chunk)
				break
			}

			toolUse.id = chunk.id
			task.assistantMessageContent.push(toolUse)
			task.userMessageContentReady = false
			presentAssistantMessage(task)
			break
		}
		case "text": {
			const assistantMessage = appendAssistantText(chunk.text)
			globalQueryProfiler.markFirstToken(requestProfileId)

			const lastBlock = task.assistantMessageContent[task.assistantMessageContent.length - 1]
			if (lastBlock?.type === "text" && lastBlock.partial) {
				lastBlock.content = assistantMessage
			} else {
				task.assistantMessageContent.push({
					type: "text",
					content: assistantMessage,
					partial: true,
				})
				task.userMessageContentReady = false
			}
			presentAssistantMessage(task)
			break
		}
	}
}

export async function finalizePendingStreamingToolCalls(options: {
	task: TaskExecutorHost
	toolCallParser: NativeToolCallParser
	finalizeToolUse: FinalizeToolUse
}): Promise<void> {
	const { task, toolCallParser, finalizeToolUse } = options
	const finalizeEvents = toolCallParser.finalizeRawChunks()
	for (const event of finalizeEvents) {
		if (event.type === "tool_call_end") {
			await handleFinalToolCall(task, toolCallParser, finalizeToolUse, event.id)
		}
	}
}
