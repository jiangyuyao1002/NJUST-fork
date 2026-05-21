import type { ApiStream } from "../../../transform/stream"
import type { ResponsesStreamEvent } from "../base"
import type { EventHandlerContext } from "./types"

export async function* handleTextEvent(event: ResponsesStreamEvent, ctx: EventHandlerContext): ApiStream {
	const type = event?.type

	if (type === "response.text.delta" || type === "response.output_text.delta") {
		if (event?.delta) {
			ctx.sawTextDeltaInCurrentResponse = true
			ctx.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: event.delta }
		}
		return
	}

	if (type === "response.text.done" || type === "response.output_text.done") {
		const doneText =
			typeof event?.text === "string"
				? event.text
				: typeof event?.output_text === "string"
					? event.output_text
					: typeof event?.delta === "string"
						? event.delta
						: undefined
		if (!ctx.sawTextOutputInCurrentResponse && doneText) {
			ctx.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: doneText }
		}
		return
	}

	if (type === "response.content_part.added" || type === "response.content_part.done") {
		const part = event?.part
		if (
			!ctx.sawTextDeltaInCurrentResponse &&
			(part?.type === "text" || part?.type === "output_text") &&
			(typeof part?.text === "string" || typeof part?.text?.value === "string")
		) {
			const partText = typeof part.text === "string" ? part.text : part.text.value
			if (partText) {
				ctx.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: partText }
			}
		}
		return
	}

	if (type === "response.refusal.delta") {
		if (event?.delta) {
			ctx.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: `[Refusal] ${event.delta}` }
		}
		return
	}

	if (type === "response.audio_transcript.delta") {
		if (event?.delta) {
			yield { type: "text", text: event.delta }
		}
		return
	}
}
