import type { ApiStream } from "../../../transform/stream"
import type { OpenAiNativeModel, ResponsesStreamEvent } from "../base"
import type { EventHandlerContext } from "./types"

export async function* handleFallback(
	event: ResponsesStreamEvent,
	model: OpenAiNativeModel,
	ctx: EventHandlerContext,
): ApiStream {
	// Handle response.output for events without specific type handlers
	if (event?.response?.output && Array.isArray(event.response.output)) {
		for (const outputItem of event.response.output) {
			if (outputItem.type === "text" && outputItem.content) {
				for (const content of outputItem.content) {
					if (content.type === "text" && content.text) {
						yield { type: "text", text: content.text }
					}
				}
			}
			if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
				for (const summary of outputItem.summary) {
					if (summary?.type === "summary_text" && typeof summary.text === "string") {
						yield { type: "reasoning", text: summary.text }
					}
				}
			}
		}
		if (event.response.usage) {
			const usageData = ctx.normalizeUsage(event.response.usage, model)
			if (usageData) {
				yield usageData
			}
		}
		return
	}

	// Fallback for chat completions format
	if (event?.choices?.[0]?.delta?.content) {
		ctx.sawTextDeltaInCurrentResponse = true
		ctx.sawTextOutputInCurrentResponse = true
		yield { type: "text", text: event.choices[0].delta.content }
		return
	}

	// Fallback for item.text
	if (event?.item && typeof event.item.text === "string" && event.item.text.length > 0) {
		ctx.sawTextOutputInCurrentResponse = true
		yield { type: "text", text: event.item.text }
		return
	}

	// Usage event
	if (event?.usage) {
		const usageData = ctx.normalizeUsage(event.usage, model)
		if (usageData) {
			yield usageData
		}
		return
	}
}
