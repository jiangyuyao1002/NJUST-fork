import type { ApiStream } from "../../../transform/stream"
import type { ResponsesStreamEvent } from "../base"
import type { EventHandlerContext } from "./types"

export async function* handleToolEvent(event: ResponsesStreamEvent, ctx: EventHandlerContext): ApiStream {
	const type = event?.type

	if (type === "response.tool_call_arguments.delta" || type === "response.function_call_arguments.delta") {
		const callId = event.call_id || event.tool_call_id || event.id || ctx.pendingToolCallId || undefined
		const name = event.name || event.function_name || ctx.pendingToolCallName || undefined
		const args = event.delta || event.arguments

		if (typeof name === "string" && name.length > 0 && typeof callId === "string" && callId.length > 0) {
			ctx.streamedToolCallIds.add(callId)
			yield {
				type: "tool_call_partial",
				index: event.index ?? 0,
				id: callId,
				name,
				arguments: args,
			}
		}
		return
	}

	if (type === "response.tool_call_arguments.done" || type === "response.function_call_arguments.done") {
		return
	}

	if (type === "response.output_item.added" || type === "response.output_item.done") {
		const item = event?.item
		if (item) {
			if (item.type === "function_call" || item.type === "tool_call") {
				const callId = item.call_id || item.tool_call_id || item.id
				const name = item.name || item.function?.name || item.function_name
				if (typeof callId === "string" && callId.length > 0) {
					ctx.pendingToolCallId = callId
					ctx.pendingToolCallName = typeof name === "string" ? name : undefined
				}
			}

			if (event.type === "response.output_item.added") {
				if (item.type === "text" && item.text) {
					ctx.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: item.text }
				} else if (item.type === "output_text" && item.text) {
					ctx.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: item.text }
				} else if (item.type === "reasoning" && item.text) {
					yield { type: "reasoning", text: item.text }
				} else if (item.type === "message" && Array.isArray(item.content)) {
					for (const content of item.content) {
						if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
							ctx.sawTextOutputInCurrentResponse = true
							yield { type: "text", text: content.text }
						}
					}
				}
			} else if (
				event.type === "response.output_item.done" &&
				(item.type === "function_call" || item.type === "tool_call")
			) {
				const callId = item.call_id || item.tool_call_id || item.id
				const name = item.name || item.function?.name || item.function_name
				const argsRaw = item.arguments || item.function?.arguments || item.input
				const args =
					typeof argsRaw === "string"
						? argsRaw
						: argsRaw && typeof argsRaw === "object"
							? JSON.stringify(argsRaw)
							: ""

				if (
					typeof callId === "string" &&
					callId.length > 0 &&
					typeof name === "string" &&
					name.length > 0 &&
					!ctx.streamedToolCallIds.has(callId)
				) {
					yield {
						type: "tool_call",
						id: callId,
						name,
						arguments: args,
					}
				}
			} else if (!ctx.sawTextOutputInCurrentResponse) {
				if ((item.type === "text" || item.type === "output_text") && item.text) {
					ctx.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: item.text }
				} else if (item.type === "message" && Array.isArray(item.content)) {
					for (const content of item.content) {
						if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
							ctx.sawTextOutputInCurrentResponse = true
							yield { type: "text", text: content.text }
						}
					}
				}
			}
		}
		return
	}
}
