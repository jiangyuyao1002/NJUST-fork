/**
 * TaskToolHandler — Manages tool result accumulation, duplicate detection,
 * and tool dispatch coordination.
 *
 * Extracted from Task.ts to decompose the monolithic file.
 *
 * Phase 1: pushToolResultToUserContent + duplicate detection.
 * Phase 2 (future): tool dispatch routing, caching, and concurrency
 * management (currently in Task + ToolExecutionContext).
 */
import type { Anthropic } from "@anthropic-ai/sdk"
import { logger } from "../../shared/logger"

export interface TaskToolHandlerContext {
	userMessageContent: Anthropic.Messages.ContentBlockParam[]
	readonly taskId: string
}

export class TaskToolHandler {
	constructor(private ctx: TaskToolHandlerContext) {}

	/**
	 * Push a tool result into the pending user message content buffer.
	 * Returns false (and logs a warning) if a result with the same
	 * tool_use_id already exists — preventing duplicate tool_result blocks.
	 */
	pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const existingResult = this.ctx.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			logger.warn("TaskToolHandler",
				`Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		this.ctx.userMessageContent.push(toolResult)
		return true
	}
}
