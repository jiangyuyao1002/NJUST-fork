import type { ApiStream } from "../../../transform/stream"
import type { OpenAiNativeModel, ResponsesStreamEvent } from "../base"
import { handleFallback } from "./fallback-handlers"
import { handleReasoningEvent } from "./reasoning-handlers"
import { handleStatusEvent } from "./status-handlers"
import { handleTextEvent } from "./text-handlers"
import { handleToolEvent } from "./tool-handlers"
import type { EventHandlerContext } from "./types"

export * from "./types"
export { handleFallback } from "./fallback-handlers"
export { handleReasoningEvent } from "./reasoning-handlers"
export { handleStatusEvent } from "./status-handlers"
export { handleTextEvent } from "./text-handlers"
export { handleToolEvent } from "./tool-handlers"

const NO_OP_EVENTS = new Set([
	"response.audio.delta",
	"response.audio.done",
	"response.audio_transcript.done",
	"response.reasoning.done",
	"response.reasoning_text.done",
	"response.reasoning_summary.done",
	"response.reasoning_summary_text.done",
	"response.mcp_call_arguments.delta",
	"response.mcp_call_arguments.done",
	"response.mcp_call.in_progress",
	"response.mcp_call.completed",
	"response.mcp_call.failed",
	"response.mcp_list_tools.in_progress",
	"response.mcp_list_tools.completed",
	"response.mcp_list_tools.failed",
	"response.web_search_call.searching",
	"response.web_search_call.in_progress",
	"response.web_search_call.completed",
	"response.code_interpreter_call_code.delta",
	"response.code_interpreter_call_code.done",
	"response.code_interpreter_call.interpreting",
	"response.code_interpreter_call.in_progress",
	"response.code_interpreter_call.completed",
	"response.file_search_call.searching",
	"response.file_search_call.in_progress",
	"response.file_search_call.completed",
	"response.image_gen_call.generating",
	"response.image_gen_call.in_progress",
	"response.image_gen_call.partial_image",
	"response.image_gen_call.completed",
	"response.computer_tool_call.output_item",
	"response.computer_tool_call.output_screenshot",
	"response.output_text_annotation.added",
	"response.text_annotation.added",
])

export function updateResponseState(event: ResponsesStreamEvent, ctx: EventHandlerContext): void {
	if (event?.response?.service_tier) {
		ctx.lastServiceTier = event.response.service_tier
	}
	if (event?.response?.output && Array.isArray(event.response.output)) {
		ctx.lastResponseOutput = event.response.output
	}
	if (event?.response?.id) {
		ctx.lastResponseId = event.response.id as string
	}
}

export async function* dispatchEvent(
	event: ResponsesStreamEvent,
	model: OpenAiNativeModel,
	ctx: EventHandlerContext,
	options?: { sseHasContent?: boolean },
): ApiStream {
	updateResponseState(event, ctx)

	const type = event?.type
	if (!type) {
		yield* handleFallback(event, model, ctx)
		return
	}

	if (NO_OP_EVENTS.has(type)) {
		return
	}

	// Text events
	if (
		type === "response.text.delta" ||
		type === "response.output_text.delta" ||
		type === "response.text.done" ||
		type === "response.output_text.done" ||
		type === "response.content_part.added" ||
		type === "response.content_part.done" ||
		type === "response.refusal.delta" ||
		type === "response.audio_transcript.delta"
	) {
		yield* handleTextEvent(event, ctx)
		return
	}

	// Reasoning events
	if (
		type === "response.reasoning.delta" ||
		type === "response.reasoning_text.delta" ||
		type === "response.reasoning_summary.delta" ||
		type === "response.reasoning_summary_text.delta"
	) {
		yield* handleReasoningEvent(event, ctx)
		return
	}

	// Tool events
	if (
		type === "response.tool_call_arguments.delta" ||
		type === "response.function_call_arguments.delta" ||
		type === "response.tool_call_arguments.done" ||
		type === "response.function_call_arguments.done" ||
		type === "response.output_item.added" ||
		type === "response.output_item.done"
	) {
		yield* handleToolEvent(event, ctx)
		return
	}

	// Status events
	if (
		type === "response.done" ||
		type === "response.completed" ||
		type === "response.created" ||
		type === "response.in_progress" ||
		type === "response.error" ||
		type === "error" ||
		type === "response.failed" ||
		type === "response.incomplete" ||
		type === "response.queued"
	) {
		yield* handleStatusEvent(event, model, ctx, options?.sseHasContent)
		return
	}

	// Fallback for unknown types
	yield* handleFallback(event, model, ctx)
}
