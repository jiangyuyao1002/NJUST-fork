import { ApiProviderError } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { getErrorMessage } from "../../../shared/error-utils"
import { reportExtensionError } from "../../../utils/errorReporter"
import type { ApiStream } from "../../transform/stream"
import { type OpenAiNativeModel, type ResponsesStreamEvent } from "./base"
import { dispatchEvent, type EventHandlerContext } from "./event-handlers"

export interface SseParserContext extends EventHandlerContext {
	abortController?: AbortController
	providerName: string
}

// Maximum allowed length for a single SSE line (including incomplete buffers).
// Prevents OOM from malformed streams that never emit a newline.
const MAX_SSE_BUFFER_LENGTH = 1024 * 1024 // 1 MB

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	model: OpenAiNativeModel,
	ctx: SseParserContext,
): ApiStream {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	let hasContent = false
	let sseJsonParseFailureCount = 0

	try {
		while (true) {
			if (ctx.abortController?.signal.aborted) {
				break
			}

			const { done, value } = await reader.read()
			if (done) break

			buffer += decoder.decode(value, { stream: true })
			if (buffer.length > MAX_SSE_BUFFER_LENGTH) {
				throw new ApiProviderError("SSE line exceeded maximum length, possible malformed stream")
			}
			const lines = buffer.split("\n")
			buffer = lines.pop() || ""

			for (const line of lines) {
				if (line.startsWith("data: ")) {
					const data = line.slice(6).trim()
					if (data === "[DONE]") {
						continue
					}

					try {
						// NOTE: We intentionally do NOT use Zod here. OpenAI's Responses API
						// event schema is too dynamic and loosely documented. Attempting to
						// validate it with Zod would either (a) be a no-op (accept anything),
						// or (b) break when OpenAI adds new event types or fields. We rely
						// on the TypeScript interface and defensive runtime checks in handlers.
						const parsed = JSON.parse(data) as ResponsesStreamEvent

						for await (const outChunk of dispatchEvent(parsed, model, ctx, { sseHasContent: hasContent })) {
							if (
								outChunk.type === "text" ||
								outChunk.type === "reasoning" ||
								outChunk.type === "tool_call" ||
								outChunk.type === "tool_call_partial"
							) {
								hasContent = true
							}
							yield outChunk
						}
					} catch (e) {
						// JSON.parse throws SyntaxError for invalid JSON. Other errors from
						// dispatchEvent (e.g. ApiProviderError from status handlers) are
						// re-thrown to abort the stream.
						if (e instanceof SyntaxError) {
							sseJsonParseFailureCount++
							if (sseJsonParseFailureCount <= 3) {
								const preview = data.length > 220 ? `${data.slice(0, 220)}…` : data
								reportExtensionError(
									"OpenAI-Native/SSE",
									e instanceof Error ? e : new Error(String(e)),
									{ count: sseJsonParseFailureCount, preview },
								)
							}
						} else {
							throw e
						}
					}
				} else if (line.trim() && !line.startsWith(":")) {
					// Non-standard lines (not prefixed with "data: ") may contain JSON
					// events from some proxy implementations. Route them through
					// dispatchEvent for consistent handling, but silently skip
					// non-JSON plain-text or heartbeat lines.
					try {
						const parsed = JSON.parse(line) as ResponsesStreamEvent
						for await (const outChunk of dispatchEvent(parsed, model, ctx, { sseHasContent: hasContent })) {
							if (
								outChunk.type === "text" ||
								outChunk.type === "reasoning" ||
								outChunk.type === "tool_call" ||
								outChunk.type === "tool_call_partial"
							) {
								hasContent = true
							}
							yield outChunk
						}
					} catch (e) {
						// Only swallow SyntaxError (non-JSON plain text). Propagate
						// any other error from dispatchEvent.
						if (e instanceof SyntaxError) {
							sseJsonParseFailureCount++
							if (sseJsonParseFailureCount <= 3) {
								const preview = line.length > 220 ? `${line.slice(0, 220)}…` : line
								reportExtensionError(
									"OpenAI-Native/SSE",
									e instanceof Error ? e : new Error(String(e)),
									{ count: sseJsonParseFailureCount, preview, source: "non-data-line" },
								)
							}
						} else {
							throw e
						}
					}
				}
			}
		}

		if (buffer.trim().length > 0) {
			const preview = buffer.length > 300 ? `${buffer.trimStart().slice(0, 300)}…` : buffer.trimStart()
			reportExtensionError("OpenAI-Native/SSE", new Error("Stream ended with incomplete buffer"), {
				bufferChars: buffer.length,
				preview,
			})
		}
	} catch (error) {
		if (TelemetryService.hasInstance()) {
			const msg = getErrorMessage(error)
			const forTelemetry = new ApiProviderError(msg)
			forTelemetry.provider = ctx.providerName
			forTelemetry.modelId = model.id
			forTelemetry.operation = "createMessage"
			TelemetryService.instance.captureException(forTelemetry)
		}
		if (error instanceof Error) {
			throw new ApiProviderError(`Error processing response stream: ${error.message}`)
		}
		throw new ApiProviderError("Unexpected error processing response stream")
	} finally {
		reader.releaseLock()
	}
}
