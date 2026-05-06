import { describe, expect, it } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { microcompactMessages } from "../microcompact"

describe("microcompactMessages", () => {
	it("returns original messages when disabled", () => {
		const messages: ApiMessage[] = [{ role: "user", content: "hello" }]
		const result = microcompactMessages(messages, { enabled: false })
		expect(result).toBe(messages)
	})

	it("keeps empty list unchanged", () => {
		const messages: ApiMessage[] = []
		const result = microcompactMessages(messages)
		expect(result).toBe(messages)
	})

	it("compacts oversized historical tool_result content", () => {
		const huge = Array.from({ length: 1800 }, (_, i) => `line-${i}: ${"x".repeat(40)}`).join("\n")
		const messages: ApiMessage[] = [
			{ role: "user", content: "filler-1" },
			{ role: "assistant", content: "filler-2" },
			{ role: "user", content: "filler-3" },
			{ role: "assistant", content: "filler-4" },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: huge } as any],
			},
			{ role: "user", content: "after-1" },
			{ role: "assistant", content: "after-2" },
			{ role: "user", content: "after-3" },
			{ role: "user", content: "turn-current" },
		]

		const result = microcompactMessages(messages)
		const compacted = ((result[4].content as any[])[0]?.content as string) ?? ""
		expect(compacted.length).toBeLessThan(huge.length)
		expect(compacted).toContain("tool result compacted")
	})

	it("keeps recent messages intact", () => {
		const huge = Array.from({ length: 1800 }, (_, i) => `line-${i}: ${"x".repeat(40)}`).join("\n")
		// Create messages with tool_result at the end (recent)
		const messages: ApiMessage[] = [
			{ role: "user", content: "turn-1" },
			{ role: "user", content: "turn-2" },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: huge } as any],
			},
		]

		const result = microcompactMessages(messages)
		// Recent message should not be compacted
		const lastContent = ((result[2].content as any[])[0]?.content as string) ?? ""
		expect(lastContent.length).toBe(huge.length)
		expect(lastContent).not.toContain("compacted")
	})

	it("applies progressive budget reduction to older messages", () => {
		// Create enough messages to trigger different age penalty levels
		const messages: ApiMessage[] = []
		for (let i = 0; i < 25; i++) {
			const huge = Array.from({ length: 400 }, (_, j) => `line-${j}: ${"x".repeat(40)}`).join("\n")
			messages.push({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: huge } as any],
			})
		}

		const result = microcompactMessages(messages)
		// Verify that older messages (earlier in array) are more compacted
		const firstCompacted = ((result[0].content as any[])[0]?.content as string) ?? ""
		const middleCompacted = ((result[10].content as any[])[0]?.content as string) ?? ""
		const recentCompacted = ((result[22].content as any[])[0]?.content as string) ?? ""

		// Older messages should be more aggressively compacted
		expect(firstCompacted.length).toBeLessThan(middleCompacted.length)
	})

	it("handles non-array content gracefully", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "plain text message" },
			{ role: "assistant", content: "assistant response" },
		]

		const result = microcompactMessages(messages)
		expect(result).toBe(messages)
	})

	it("handles tool_result with non-string content", () => {
		const contentObj = { data: Array.from({ length: 500 }, (_, i) => ({ id: i, value: "x".repeat(50) })) }
		const messages: ApiMessage[] = [
			{ role: "user", content: "filler-1" },
			{ role: "assistant", content: "filler-2" },
			{ role: "user", content: "filler-3" },
			{ role: "assistant", content: "filler-4" },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: contentObj } as any],
			},
			{ role: "user", content: "after-1" },
			{ role: "assistant", content: "after-2" },
			{ role: "user", content: "after-3" },
			{ role: "user", content: "turn-current" },
		]

		const result = microcompactMessages(messages)
		const compacted = ((result[4].content as any[])[0]?.content as string) ?? ""
		// Should be compacted since JSON is large
		expect(compacted.length).toBeLessThan(JSON.stringify(contentObj).length)
	})

	it("preserves original messages when no compaction needed", () => {
		const smallContent = "small result"
		const messages: ApiMessage[] = [
			{ role: "user", content: "turn-1" },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: smallContent } as any],
			},
		]

		const result = microcompactMessages(messages)
		// Should return same array reference when no changes
		expect(result).toBe(messages)
	})

	it("handles tool-specific budget rules", () => {
		// read_file gets higher budget than web_search
		const huge = Array.from({ length: 800 }, (_, i) => `line-${i}: ${"x".repeat(40)}`).join("\n")
		const messages: ApiMessage[] = [
			{ role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read_file" } as any] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: huge } as any],
			},
			{ role: "assistant", content: [{ type: "tool_use", id: "tool-2", name: "web_search" } as any] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-2", content: huge } as any],
			},
			{ role: "assistant", content: "filler-1" },
			{ role: "user", content: "filler-2" },
			{ role: "assistant", content: "filler-3" },
			{ role: "user", content: "filler-4" },
			{ role: "assistant", content: "filler-5" },
		]

		const result = microcompactMessages(messages)
		const readFileResult = ((result[1].content as any[])[0]?.content as string) ?? ""
		const webSearchResult = ((result[3].content as any[])[0]?.content as string) ?? ""

		// Both should be compacted but read_file should retain more content
		expect(readFileResult.length).toBeGreaterThan(webSearchResult.length)
	})
})
