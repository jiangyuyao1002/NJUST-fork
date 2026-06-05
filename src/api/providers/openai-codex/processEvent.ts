import type { ApiStream, ApiStreamUsageChunk } from "../../transform/stream"
import type { OpenAiCodexModel, ResponsesOutputItem, ResponsesStreamEvent } from "./types"

/**
 * Mutable state context shared between the handler class and the
 * extracted processEvent function. The handler class owns these fields
 * as instance properties and passes a reference to this context.
 */
export interface CodexEventHandlerContext {
	lastResponseOutput: ResponsesOutputItem[] | undefined
	lastResponseId: string | undefined
	pendingToolCallId: string | undefined
	pendingToolCallName: string | undefined
	sawTextOutputInCurrentResponse: boolean
	sawTextDeltaInCurrentResponse: boolean
	streamedToolCallIds: Set<string>
	normalizeUsage(usage: unknown, model: OpenAiCodexModel): ApiStreamUsageChunk | undefined
}

/**
 * Process a single Responses API stream event, yielding ApiStream chunks.
 *
 * Extracted from OpenAiCodexHandler.processEvent to reduce class size.
 * Reads and writes state through the provided `ctx` context object,
 * which is typically backed by the handler's instance properties.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function* processEvent(
	event: ResponsesStreamEvent,
	model: OpenAiCodexModel,
	ctx: CodexEventHandlerContext,
): ApiStream {
	if (event?.response?.output && Array.isArray(event.response.output)) {
		ctx.lastResponseOutput = event.response.output
	}
	if (event?.response?.id) {
		ctx.lastResponseId = event.response.id as string
	}

	// Handle text deltas
	if (event?.type === "response.text.delta" || event?.type === "response.output_text.delta") {
		if (event?.delta) {
			ctx.sawTextDeltaInCurrentResponse = true
			ctx.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: event.delta }
		}
		return
	}

	if (event?.type === "response.text.done" || event?.type === "response.output_text.done") {
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

	if (event?.type === "response.content_part.added" || event?.type === "response.content_part.done") {
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

	// Handle reasoning deltas
	if (
		event?.type === "response.reasoning.delta" ||
		event?.type === "response.reasoning_text.delta" ||
		event?.type === "response.reasoning_summary.delta" ||
		event?.type === "response.reasoning_summary_text.delta"
	) {
		if (event?.delta) {
			yield { type: "reasoning", text: event.delta }
		}
		return
	}

	// Handle refusal deltas
	if (event?.type === "response.refusal.delta") {
		if (event?.delta) {
			ctx.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: `[Refusal] ${event.delta}` }
		}
		return
	}

	// Handle tool/function call deltas
	if (
		event?.type === "response.tool_call_arguments.delta" ||
		event?.type === "response.function_call_arguments.delta"
	) {
		const callId = event.call_id || event.tool_call_id || event.id || ctx.pendingToolCallId
		const name = event.name || event.function_name || ctx.pendingToolCallName
		const args = event.delta || event.arguments

		// Codex/Responses may stream tool-call arguments without stable id/name.
		// Avoid emitting incomplete tool_call_partial chunks because
		// NativeToolCallParser requires a name to start a call.
		if (typeof callId === "string" && callId.length > 0 && typeof name === "string" && name.length > 0) {
			ctx.streamedToolCallIds.add(callId)
			yield {
				type: "tool_call_partial",
				index: event.index ?? 0,
				id: callId,
				name,
				arguments: typeof args === "string" ? args : "",
			}
		}
		return
	}

	// Handle tool/function call completion
	if (
		event?.type === "response.tool_call_arguments.done" ||
		event?.type === "response.function_call_arguments.done"
	) {
		return
	}

	// Handle output item events
	if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
		const item = event?.item
		if (item) {
			// Capture tool identity so subsequent argument deltas can be attributed.
			if (item.type === "function_call" || item.type === "tool_call") {
				const callId = item.call_id || item.tool_call_id || item.id
				const name = item.name || item.function?.name || item.function_name
				if (typeof callId === "string" && callId.length > 0) {
					ctx.pendingToolCallId = callId
					ctx.pendingToolCallName = typeof name === "string" ? name : undefined
				}
			}

			// For "added" events, yield text/reasoning content (streaming path).
			// For "done" events, emit fallback text only if none was emitted yet.
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

				// Fallback for models that only emit a complete function_call in output_item.done.
				// If we already streamed partials for this ID, skip to avoid duplicate tool execution.
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

			// Note: We intentionally do NOT emit tool_call from response.output_item.done
			// for function_call/tool_call items. The streaming path handles tool calls via:
			// 1. tool_call_partial events during argument deltas
			// 2. NativeToolCallParser.finalizeRawChunks() at stream end emitting tool_call_end
			// 3. NativeToolCallParser.finalizeStreamingToolCall() creating the final ToolUse
			// Emitting tool_call here would cause duplicate tool rendering.
		}
		return
	}

	// Handle completion events
	if (event?.type === "response.done" || event?.type === "response.completed") {
		// Some Codex variants only provide assistant text in the final completed payload.
		if (!ctx.sawTextOutputInCurrentResponse && Array.isArray(event?.response?.output)) {
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

	// Fallbacks
	if (event?.choices?.[0]?.delta?.content) {
		ctx.sawTextDeltaInCurrentResponse = true
		ctx.sawTextOutputInCurrentResponse = true
		yield { type: "text", text: event.choices[0].delta.content }
		return
	}

	if (event?.usage) {
		const usageData = ctx.normalizeUsage(event.usage, model)
		if (usageData) {
			yield usageData
		}
	}
}
