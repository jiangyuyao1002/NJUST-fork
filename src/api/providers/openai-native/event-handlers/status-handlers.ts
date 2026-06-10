import { ApiProviderError } from "@njust-ai/types"
import type { ApiStream } from "../../../transform/stream"
import type { OpenAiNativeModel, ResponsesStreamEvent } from "../base"
import type { EventHandlerContext } from "./types"

export async function* handleStatusEvent(
	event: ResponsesStreamEvent,
	model: OpenAiNativeModel,
	ctx: EventHandlerContext,
	sseHasContent?: boolean,
): ApiStream {
	const type = event?.type

	if (type === "response.done" || type === "response.completed") {
		const shouldSkipTextExtraction =
			sseHasContent !== undefined ? sseHasContent : ctx.sawTextOutputInCurrentResponse

		if (!shouldSkipTextExtraction && Array.isArray(event?.response?.output)) {
			for (const outputItem of event.response.output) {
				if ((outputItem?.type === "text" || outputItem?.type === "output_text") && outputItem?.text) {
					ctx.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: outputItem.text }
					continue
				}

				if (outputItem?.type === "message" && Array.isArray(outputItem.content)) {
					for (const content of outputItem.content) {
						if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
							ctx.sawTextOutputInCurrentResponse = true
							yield { type: "text", text: content.text }
						}
					}
				}
			}
		}

		const usage = event?.response?.usage || event?.usage || undefined
		const usageData = ctx.normalizeUsage(usage, model)
		if (usageData) {
			yield usageData
		}
		return
	}

	if (type === "response.created" || type === "response.in_progress") {
		return
	}

	if (type === "response.error" || type === "error") {
		if (event?.error || event?.message) {
			throw new ApiProviderError(
				`Responses API error: ${event.error?.message || event.message || "Unknown error"}`,
			)
		}
		return
	}

	if (type === "response.failed") {
		if (event?.error || event?.message) {
			throw new ApiProviderError(`Response failed: ${event.error?.message || event.message || "Unknown failure"}`)
		}
		return
	}

	if (type === "response.incomplete" || type === "response.queued") {
		return
	}
}
