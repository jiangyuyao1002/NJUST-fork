import { describe, it, expect, vi } from "vitest"
import type { ClineMessage, UnsafeAny } from "@njust-ai/types"
import { renderClineMessage, type RenderSink } from "../message-renderer"

function createMockSink(): RenderSink & { markdownCalls: string[]; progressCalls: string[] } {
	const markdownCalls: string[] = []
	const progressCalls: string[] = []
	return {
		markdownCalls,
		progressCalls,
		markdown: vi.fn((value: string) => {
			markdownCalls.push(value)
		}),
		progress: vi.fn((value: string) => {
			progressCalls.push(value)
		}),
	}
}

function makeMessage(overrides: Partial<ClineMessage>): ClineMessage {
	return {
		id: "test-msg",
		ts: Date.now(),
		type: "say",
		...overrides,
	}
}

describe("renderClineMessage", () => {
	describe("say messages", () => {
		it("renders text as markdown", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "text", text: "Hello world" }))
			expect(sink.markdownCalls).toEqual(["Hello world"])
			expect(sink.progressCalls).toEqual([])
		})

		it("skips text when text is empty", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "text", text: "" }))
			expect(sink.markdownCalls).toEqual([])
		})

		it("renders tool with parsed name as progress", () => {
			const sink = createMockSink()
			renderClineMessage(
				sink,
				makeMessage({
					type: "say",
					say: "tool",
					text: JSON.stringify({ tool: "read_file" }),
				}),
			)
			expect(sink.progressCalls).toEqual(["Using tool: read_file"])
		})

		it("renders tool fallback when JSON parse fails", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "tool", text: "not-json" }))
			expect(sink.progressCalls).toEqual(["Executing tool..."])
		})

		it("renders tool with unknown fallback when tool name is missing", () => {
			const sink = createMockSink()
			renderClineMessage(
				sink,
				makeMessage({
					type: "say",
					say: "tool",
					text: JSON.stringify({ other: "data" }),
				}),
			)
			expect(sink.progressCalls).toEqual(["Using tool: unknown"])
		})

		it("renders completion_result with separator", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "completion_result", text: "All done" }))
			expect(sink.markdownCalls).toEqual(["\n\n---\n**Result:** All done"])
		})

		it("renders error message", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "error", text: "Something broke" }))
			expect(sink.markdownCalls).toEqual(["\n**Error:** Something broke"])
		})

		it("silently skips shell_integration_warning", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "shell_integration_warning" }))
			expect(sink.markdownCalls).toEqual([])
			expect(sink.progressCalls).toEqual([])
		})

		it("silently skips unknown say types", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "api_req_started" as UnsafeAny }))
			expect(sink.markdownCalls).toEqual([])
			expect(sink.progressCalls).toEqual([])
		})
	})

	describe("ask messages", () => {
		it("renders tool approval with parsed name", () => {
			const sink = createMockSink()
			renderClineMessage(
				sink,
				makeMessage({
					type: "ask",
					ask: "tool",
					text: JSON.stringify({ tool: "write_to_file" }),
				}),
			)
			expect(sink.markdownCalls).toHaveLength(1)
			expect(sink.markdownCalls[0]).toContain("Tool approval needed:** write_to_file")
			expect(sink.markdownCalls[0]).toContain("Njust-AI sidebar")
		})

		it("renders tool approval fallback on invalid JSON", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "ask", ask: "tool", text: "bad-json" }))
			expect(sink.markdownCalls).toHaveLength(1)
			expect(sink.markdownCalls[0]).toContain("Tool approval needed.")
		})

		it("renders followup question", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "ask", ask: "followup", text: "What color?" }))
			expect(sink.markdownCalls).toEqual(["\n**Question:** What color?\n"])
		})

		it("silently skips unknown ask types", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "ask", ask: "command" as UnsafeAny }))
			expect(sink.markdownCalls).toEqual([])
			expect(sink.progressCalls).toEqual([])
		})
	})

	describe("edge cases", () => {
		it("handles missing text gracefully for all types", () => {
			const sink = createMockSink()
			renderClineMessage(sink, makeMessage({ type: "say", say: "text" }))
			renderClineMessage(sink, makeMessage({ type: "say", say: "tool" }))
			renderClineMessage(sink, makeMessage({ type: "say", say: "completion_result" }))
			renderClineMessage(sink, makeMessage({ type: "say", say: "error" }))
			renderClineMessage(sink, makeMessage({ type: "ask", ask: "tool" }))
			renderClineMessage(sink, makeMessage({ type: "ask", ask: "followup" }))
			expect(sink.markdownCalls).toEqual([])
			expect(sink.progressCalls).toEqual([])
		})
	})
})
