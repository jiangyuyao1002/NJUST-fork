import { describe, expect, it } from "vitest"

import { ApiMessage } from "../../task-persistence/apiMessages"
import { applyToolResultBudget } from "../toolResultBudget"
import { snipCompactMessages } from "../snipCompact"

describe("tool result budget", () => {
	it("compacts old oversized tool_result content but keeps recent intact", () => {
		const oldLarge = "A".repeat(40_000)
		const recentLarge = "B".repeat(40_000)
		const messages: ApiMessage[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_old", name: "read_file", input: {} } as any],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_old",
						name: "read_file",
						content: oldLarge,
					},
				],
			},
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "recent-1" },
			{ role: "assistant", content: "recent-2" },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_new",
						name: "read_file",
						content: recentLarge,
					},
				],
			},
		]

		const out = applyToolResultBudget(messages, { recentMessagesToKeepFull: 2 })
		// out[0] is assistant with tool_use (not compacted), out[1] is user with tool_result (compacted)
		// out[3] and out[4] are within recentMessagesToKeepFull=2 so kept intact
		const first = (out[1].content as any[])[0].content as string
		const last = (out[5].content as any[])[0].content as string

		expect(first.length).toBeLessThan(oldLarge.length)
		expect(first).toContain("file content compacted")
		expect(last.length).toBe(recentLarge.length)
	})

	it("summarizes grep/search-style outputs by line budget before generic truncation", () => {
		const lines = Array.from(
			{ length: 1400 },
			(_, i) => `src/file${i}.ts:${i + 1}:match and some extra payload text`,
		).join("\n")
		const messages: ApiMessage[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "toolu_search", name: "grep_search", input: {} } as any],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_search",
						name: "grep_search",
						content: lines,
					},
				],
			},
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "recent" },
		]

		const out = applyToolResultBudget(messages, { recentMessagesToKeepFull: 1, defaultMaxChars: 6_000 })
		// out[0] is assistant with tool_use, out[1] is user with tool_result (the compacted one)
		const compacted = (out[1].content as any[])[0].content as string
		expect(compacted).toContain("search results compacted")
		expect(compacted.length).toBeLessThan(lines.length)
	})
})

describe("snip compact", () => {
	it("only compacts old long string messages when trigger reached", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "X".repeat(1200) },
			{ role: "assistant", content: "Y".repeat(1200) },
			{ role: "user", content: "recent" },
		]
		const out = snipCompactMessages(messages, { contextPercent: 60, keepRecentMessages: 1 })
		expect(typeof out[0].content).toBe("string")
		expect((out[0].content as string).length).toBeLessThan((messages[0].content as string).length)
		expect(out[2].content).toBe("recent")
	})
})
