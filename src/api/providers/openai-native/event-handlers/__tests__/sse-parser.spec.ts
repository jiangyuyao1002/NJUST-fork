import { describe, it, expect } from "vitest"
import { parseSseStream } from "../../sse-parser"
import type { SseParserContext } from "../../sse-parser"
import type { OpenAiNativeModel } from "../../base"

function createMockModel(): OpenAiNativeModel {
	return { id: "gpt-5.1", info: { inputPrice: 1.25, outputPrice: 10 } } as any
}

function createMockCtx(): SseParserContext {
	return {
		lastServiceTier: undefined,
		lastResponseOutput: undefined,
		lastResponseId: undefined,
		pendingToolCallId: undefined,
		pendingToolCallName: undefined,
		sawTextOutputInCurrentResponse: false,
		sawTextDeltaInCurrentResponse: false,
		streamedToolCallIds: new Set(),
		normalizeUsage: () => undefined,
		providerName: "OpenAI Native",
	}
}

function createStream(lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line))
			}
			controller.close()
		},
	})
}

describe("parseSseStream", () => {
	it("should parse basic text delta events", async () => {
		const stream = createStream([
			'data: {"type":"response.text.delta","delta":"Hello"}\n\n',
			'data: {"type":"response.text.delta","delta":" world"}\n\n',
			'data: [DONE]\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks).toHaveLength(2)
		expect(textChunks[0].text).toBe("Hello")
		expect(textChunks[1].text).toBe(" world")
	})

	it("should handle [DONE] markers", async () => {
		const stream = createStream([
			'data: {"type":"response.text.delta","delta":"Done"}\n\n',
			"data: [DONE]\n\n",
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		expect(chunks.filter((c) => c.type === "text")).toHaveLength(1)
	})

	it("should handle invalid JSON gracefully", async () => {
		const stream = createStream([
			'data: {"type":"response.text.delta","delta":"Before"}\n\n',
			'data: {invalid json}\n\n',
			'data: {"type":"response.text.delta","delta":"After"}\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks).toHaveLength(2)
		expect(textChunks[0].text).toBe("Before")
		expect(textChunks[1].text).toBe("After")
	})

	it("should handle non-data lines that contain JSON", async () => {
		const stream = createStream([
			'{"type":"response.text.delta","delta":"Plain JSON line","text":"Plain JSON line"}\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks).toHaveLength(1)
		expect(textChunks[0].text).toBe("Plain JSON line")
	})

	it("should ignore comment lines", async () => {
		const stream = createStream([
			": this is a comment\n",
			'data: {"type":"response.text.delta","delta":"After comment"}\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		expect(chunks.filter((c) => c.type === "text")).toHaveLength(1)
	})

	it("should handle events split across chunks", async () => {
		const encoder = new TextEncoder()
		const stream = new ReadableStream({
			start(controller) {
				// Split a single event across multiple chunks
				controller.enqueue(encoder.encode('data: {"type":"response.text.delta","'))
				controller.enqueue(encoder.encode('delta":"Split"}\n\n'))
				controller.close()
			},
		})

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		expect(chunks.filter((c) => c.type === "text")).toHaveLength(1)
		expect(chunks[0].text).toBe("Split")
	})

	it("should handle response.done with usage", async () => {
		const ctx = createMockCtx()
		ctx.normalizeUsage = () => ({ type: "usage", inputTokens: 100, outputTokens: 20, totalCost: 0.001 })

		const stream = createStream([
			'data: {"type":"response.done","response":{"usage":{"prompt_tokens":100,"completion_tokens":20}}}\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), ctx)) {
			chunks.push(chunk)
		}

		const usageChunks = chunks.filter((c) => c.type === "usage")
		expect(usageChunks).toHaveLength(1)
	})

	it("should propagate errors from status handlers", async () => {
		const stream = createStream([
			'data: {"type":"response.error","error":{"message":"Model overloaded"}}\n\n',
		])

		await expect(async () => {
			for await (const _ of parseSseStream(stream, createMockModel(), createMockCtx())) {
				// should throw
			}
		}).rejects.toThrow("Model overloaded")
	})

	it("should respect abort signal", async () => {
		const abortController = new AbortController()
		const ctx = createMockCtx()
		ctx.abortController = abortController

		const encoder = new TextEncoder()
		let enqueued = false
		const stream = new ReadableStream({
			pull(controller) {
				if (!enqueued) {
					enqueued = true
					controller.enqueue(encoder.encode('data: {"type":"response.text.delta","delta":"First"}\n\n'))
					// Abort after the first chunk has been enqueued and read.
					abortController.abort()
					controller.enqueue(encoder.encode('data: {"type":"response.text.delta","delta":"Second"}\n\n'))
					controller.close()
				}
			},
		})

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), ctx)) {
			chunks.push(chunk)
		}

		// After abort, no further events should be yielded.
		expect(chunks.filter((c) => c.type === "text")).toHaveLength(1)
		expect(chunks[0].text).toBe("First")
	})

	it("should handle empty stream", async () => {
		const stream = createStream([])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		expect(chunks).toHaveLength(0)
	})

	it("should handle tool call events", async () => {
		const ctx = createMockCtx()
		const stream = createStream([
			'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"test_tool"}}\n\n',
			'data: {"type":"response.tool_call_arguments.delta","call_id":"call_1","delta":"{\\"arg\\":1}"}\n\n',
			'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"test_tool","arguments":"{\\"arg\\":1}"}}\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), ctx)) {
			chunks.push(chunk)
		}

		const toolCallChunks = chunks.filter((c) => c.type === "tool_call" || c.type === "tool_call_partial")
		expect(toolCallChunks.length).toBeGreaterThan(0)
		expect(ctx.pendingToolCallId).toBe("call_1")
		expect(ctx.pendingToolCallName).toBe("test_tool")
	})

	it("should handle reasoning events", async () => {
		const stream = createStream([
			'data: {"type":"response.reasoning.delta","delta":"Thinking step 1..."}\n\n',
			'data: {"type":"response.text.delta","delta":"Answer"}\n\n',
		])

		const chunks: any[] = []
		for await (const chunk of parseSseStream(stream, createMockModel(), createMockCtx())) {
			chunks.push(chunk)
		}

		const reasoningChunks = chunks.filter((c) => c.type === "reasoning")
		const textChunks = chunks.filter((c) => c.type === "text")
		expect(reasoningChunks).toHaveLength(1)
		expect(reasoningChunks[0].text).toBe("Thinking step 1...")
		expect(textChunks).toHaveLength(1)
		expect(textChunks[0].text).toBe("Answer")
	})
})
