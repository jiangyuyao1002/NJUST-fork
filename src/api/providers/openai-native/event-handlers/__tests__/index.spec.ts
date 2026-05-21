import { describe, it, expect } from "vitest"
import { type ResponsesStreamEvent } from "../../base"
import { updateResponseState, dispatchEvent } from "../index"
import type { EventHandlerContext } from "../types"

function createMockCtx(): EventHandlerContext {
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
	}
}

function createMockModel(): any {
	return { id: "gpt-5.1", info: { inputPrice: 1.25, outputPrice: 10 } }
}

describe("updateResponseState", () => {
	it("should update lastServiceTier from event.response.service_tier", () => {
		const ctx = createMockCtx()
		updateResponseState({ type: "response.done", response: { service_tier: "flex" } }, ctx)
		expect(ctx.lastServiceTier).toBe("flex")
	})

	it("should update lastResponseOutput from event.response.output", () => {
		const ctx = createMockCtx()
		const output = [{ type: "text", text: "hello" }]
		updateResponseState({ type: "response.done", response: { output } }, ctx)
		expect(ctx.lastResponseOutput).toEqual(output)
	})

	it("should update lastResponseId from event.response.id", () => {
		const ctx = createMockCtx()
		updateResponseState({ type: "response.done", response: { id: "resp_123" } }, ctx)
		expect(ctx.lastResponseId).toBe("resp_123")
	})

	it("should handle undefined event gracefully", () => {
		const ctx = createMockCtx()
		updateResponseState(undefined as any, ctx)
		expect(ctx.lastServiceTier).toBeUndefined()
	})
})

describe("dispatchEvent", () => {
	it("should route text.delta events to handleTextEvent", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = { type: "response.text.delta", delta: "Hello" }
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual({ type: "text", text: "Hello" })
		expect(ctx.sawTextDeltaInCurrentResponse).toBe(true)
	})

	it("should route output_text.delta events to handleTextEvent", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = { type: "response.output_text.delta", delta: "World" }
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual({ type: "text", text: "World" })
	})

	it("should route reasoning.delta events to handleReasoningEvent", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = { type: "response.reasoning.delta", delta: "Thinking..." }
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual({ type: "reasoning", text: "Thinking..." })
	})

	it("should route tool_call_arguments.delta events to handleToolEvent", async () => {
		const ctx = createMockCtx()
		ctx.pendingToolCallId = "call_1"
		ctx.pendingToolCallName = "test_tool"
		const event: ResponsesStreamEvent = {
			type: "response.tool_call_arguments.delta",
			call_id: "call_1",
			delta: '{"arg":1}',
		}
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0].type).toBe("tool_call_partial")
		expect(chunks[0].id).toBe("call_1")
		expect(chunks[0].name).toBe("test_tool")
	})

	it("should route output_item.added with function_call to handleToolEvent", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = {
			type: "response.output_item.added",
			item: { type: "function_call", call_id: "call_2", name: "my_func" },
		}
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(ctx.pendingToolCallId).toBe("call_2")
		expect(ctx.pendingToolCallName).toBe("my_func")
	})

	it("should route response.done events to handleStatusEvent", async () => {
		const ctx = createMockCtx()
		ctx.normalizeUsage = () => ({ type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0.001 })
		const event: ResponsesStreamEvent = {
			type: "response.done",
			response: { usage: { prompt_tokens: 10, completion_tokens: 5 } },
		}
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0].type).toBe("usage")
	})

	it("should throw on response.error events", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = {
			type: "response.error",
			error: { message: "Model overloaded" },
		}
		await expect(async () => {
			for await (const _ of dispatchEvent(event, createMockModel(), ctx)) {
				// should throw
			}
		}).rejects.toThrow("Model overloaded")
	})

	it("should handle NO_OP events silently", async () => {
		const ctx = createMockCtx()
		const noOpEventTypes = [
			"response.audio.delta",
			"response.reasoning.done",
			"response.web_search_call.searching",
			"response.code_interpreter_call.in_progress",
		]
		for (const eventType of noOpEventTypes) {
			const event: ResponsesStreamEvent = { type: eventType }
			const chunks: any[] = []
			for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
				chunks.push(chunk)
			}
			expect(chunks).toHaveLength(0)
		}
	})

	it("should fallback for unknown event types", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = {
			type: "unknown.event",
			response: {
				output: [{ type: "text", content: [{ type: "text", text: "Fallback" }] }],
			},
		}
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual({ type: "text", text: "Fallback" })
	})

	it("should fallback for events without type", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = { choices: [{ delta: { content: "Chat completion" } }] }
		const chunks: any[] = []
		for await (const chunk of dispatchEvent(event, createMockModel(), ctx)) {
			chunks.push(chunk)
		}
		expect(chunks).toHaveLength(1)
		expect(chunks[0]).toEqual({ type: "text", text: "Chat completion" })
	})

	it("should update response state before dispatching", async () => {
		const ctx = createMockCtx()
		const event: ResponsesStreamEvent = {
			type: "response.text.delta",
			delta: "Hi",
			response: { id: "resp_abc", service_tier: "default" },
		}
		for await (const _ of dispatchEvent(event, createMockModel(), ctx)) {
			// consume
		}
		expect(ctx.lastResponseId).toBe("resp_abc")
		expect(ctx.lastServiceTier).toBe("default")
	})
})
