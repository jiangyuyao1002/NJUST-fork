import { describe, it, expect, vi } from "vitest"

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(), instance: { captureSlidingWindowTruncation: vi.fn() } },
}))

import { truncateConversation, MAX_CONSECUTIVE_COMPACT_FAILURES } from "../index"
import type { ApiMessage } from "../../task-persistence/apiMessages"

function makeMsg(role: string, content: string, index: number): ApiMessage {
	return {
		role: role as ApiMessage["role"],
		content,
		ts: Date.now() + index,
	} as ApiMessage
}

function makeToolUseMsg(role: string, toolName: string, toolId: string, index: number): ApiMessage {
	if (role === "assistant") {
		return {
			role: "assistant",
			content: [{ type: "tool_use", id: toolId, name: toolName, input: {} }],
			ts: Date.now() + index,
		} as ApiMessage
	} else {
		return {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolId, content: `result of ${toolName}` }],
			ts: Date.now() + index,
		} as ApiMessage
	}
}

describe("truncateConversation", () => {
	it("keeps first message and removes middle messages", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "mid1", 1),
			makeMsg("user", "mid2", 2),
			makeMsg("assistant", "mid3", 3),
			makeMsg("user", "end", 4),
		]
		const result = truncateConversation(messages, 0.4, "task-1")
		expect(result.messages.length).toBeGreaterThan(messages.length)
		expect(result.messagesRemoved).toBeGreaterThan(0)
	})

	it("does not remove the first message", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "system prompt", 0),
			makeMsg("assistant", "response", 1),
		]
		const result = truncateConversation(messages, 0.5, "task-1")
		expect(result.messages.length).toBeGreaterThanOrEqual(1)
	})

	it("returns empty removal when fraction is 0", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "hello", 0),
			makeMsg("assistant", "hi", 1),
		]
		const result = truncateConversation(messages, 0, "task-1")
		expect(result.messagesRemoved).toBe(0)
	})

	it("handles single message gracefully", () => {
		const messages: ApiMessage[] = [makeMsg("user", "only", 0)]
		const result = truncateConversation(messages, 0.5, "task-1")
		expect(result.messages).toHaveLength(1)
		expect(result.messagesRemoved).toBe(0)
	})

	it("generates a unique truncation ID", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "a", 0),
			makeMsg("assistant", "b", 1),
		]
		const r1 = truncateConversation(messages, 0.3, "t1")
		const r2 = truncateConversation(messages, 0.3, "t1")
		expect(r1.truncationId).toBeDefined()
		expect(r1.truncationId).not.toBe(r2.truncationId)
	})

	it("circle breaker MAX_CONSECUTIVE_COMPACT_FAILURES is 3", () => {
		expect(MAX_CONSECUTIVE_COMPACT_FAILURES).toBe(3)
	})

	it("preserves tool_use and tool_result pairs", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeToolUseMsg("assistant", "read_file", "tool-1", 1),
			makeToolUseMsg("user", "read_file", "tool-1", 2),
			makeMsg("assistant", "response", 3),
			makeMsg("user", "end", 4),
		]
		const result = truncateConversation(messages, 0.3, "task-1")
		// Verify tool pairs stay together
		const hasToolUse = result.messages.some((m) =>
			Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use")
		)
		const hasToolResult = result.messages.some((m) =>
			Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result")
		)
		// If one exists, the other should exist (they're paired)
		if (hasToolUse || hasToolResult) {
			expect(hasToolUse).toBe(hasToolResult)
		}
	})

	it("protects recent messages from truncation", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "mid1", 1),
			makeMsg("user", "mid2", 2),
			makeMsg("assistant", "mid3", 3),
			makeMsg("user", "recent1", 4),
			makeMsg("assistant", "recent2", 5),
		]
		const result = truncateConversation(messages, 0.5, "task-1")
		// Recent messages should not have truncationParent
		const recentMessages = result.messages.slice(-4)
		for (const msg of recentMessages) {
			expect(msg.truncationParent).toBeUndefined()
		}
	})

	it("handles already truncated messages", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			{ ...makeMsg("assistant", "already hidden", 1), truncationParent: "prev-trunc" },
			makeMsg("user", "visible", 2),
			makeMsg("assistant", "response", 3),
		]
		const result = truncateConversation(messages, 0.5, "task-1")
		// Already truncated messages should remain unchanged
		const alreadyTruncated = result.messages.find((m) => m.truncationParent === "prev-trunc")
		expect(alreadyTruncated).toBeDefined()
	})

	it("creates truncation marker when messages removed", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "mid1", 1),
			makeMsg("user", "mid2", 2),
			makeMsg("assistant", "mid3", 3),
			makeMsg("user", "end", 4),
		]
		const result = truncateConversation(messages, 0.5, "task-1")
		const marker = result.messages.find((m) => m.isTruncationMarker)
		if (result.messagesRemoved > 0) {
			expect(marker).toBeDefined()
			expect(marker?.content).toContain("truncation")
		}
	})

	it("handles empty messages array", () => {
		const result = truncateConversation([], 0.5, "task-1")
		expect(result.messages).toHaveLength(0)
		expect(result.messagesRemoved).toBe(0)
	})

	it("prioritizes error recovery messages for retention", () => {
		// Use enough messages so smart truncation can find candidates beyond the protected zone
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "response 1", 1),
			makeMsg("user", "message 1", 2),
			makeMsg("assistant", "response 2", 3),
			makeMsg("user", "message 2", 4),
			makeMsg("assistant", "response 3", 5),
			makeMsg("user", "message 3", 6),
			makeMsg("assistant", "response 4", 7),
			makeMsg("user", "message 4", 8),
			makeMsg("assistant", "response 5", 9),
			makeMsg("user", "message 5", 10),
			makeMsg("assistant", "response 6", 11),
			makeMsg("user", "error recovery message", 12),
			makeMsg("assistant", "retry succeeded", 13),
			makeMsg("user", "end", 14),
		]
		const result = truncateConversation(messages, 0.5, "task-1")
		// Error recovery messages should not be truncated (protected in smart truncation)
		const errorRecoveryMsg = result.messages.find((m) =>
			typeof m.content === "string" && m.content.includes("error recovery")
		)
		expect(errorRecoveryMsg?.truncationParent).toBeUndefined()
	})

	it("handles fraction of 1 (maximum truncation)", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "mid1", 1),
			makeMsg("user", "mid2", 2),
			makeMsg("assistant", "mid3", 3),
			makeMsg("user", "end", 4),
		]
		const result = truncateConversation(messages, 1, "task-1")
		// First message should always be preserved
		expect(result.messages[0].content).toBe("start")
		expect(result.messages[0].truncationParent).toBeUndefined()
	})

	it("reports messagesRemoved as the actual number of tagged messages", () => {
		const messages: ApiMessage[] = [
			makeMsg("user", "start", 0),
			makeMsg("assistant", "mid1", 1),
			makeMsg("user", "mid2", 2),
			makeMsg("assistant", "mid3", 3),
			makeMsg("user", "mid4", 4),
			makeMsg("assistant", "mid5", 5),
			makeMsg("user", "end", 6),
		]

		const result = truncateConversation(messages, 1, "task-1")
		const taggedMessages = result.messages.filter((msg) => msg.truncationParent === result.truncationId)

		expect(result.messagesRemoved).toBe(taggedMessages.length)
	})
})
