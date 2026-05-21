import type { ApiStream } from "../../../transform/stream"
import type { ResponsesStreamEvent } from "../base"
import type { EventHandlerContext } from "./types"

export async function* handleReasoningEvent(event: ResponsesStreamEvent, _ctx: EventHandlerContext): ApiStream {
	const type = event?.type

	if (
		type === "response.reasoning.delta" ||
		type === "response.reasoning_text.delta" ||
		type === "response.reasoning_summary.delta" ||
		type === "response.reasoning_summary_text.delta"
	) {
		if (event?.delta) {
			yield { type: "reasoning", text: event.delta }
		}
		return
	}
}
