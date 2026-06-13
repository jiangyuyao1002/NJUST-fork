import { describe, it, expect } from "vitest"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import type { ContextHierarchy } from "../contextHierarchy"
import { snipCompactMessages } from "../snipCompact"

function makeMsg(content: string, overrides: Partial<ApiMessage> = {}): ApiMessage {
	return { role: "assistant", content, ...overrides } as ApiMessage
}

function makeLongText(n: number): string {
	return "x".repeat(n)
}

describe("snipCompactMessages", () => {
	it("returns empty array for empty input", () => {
		expect(snipCompactMessages([], { contextPercent: 60 })).toEqual([])
	})

	it("returns unchanged when contextPercent < triggerPercent", () => {
		const msgs = [makeMsg("hello")]
		expect(snipCompactMessages(msgs, { contextPercent: 40, triggerPercent: 50 })).toBe(msgs)
	})

	it("leaves recent messages unchanged", () => {
		const msgs = [makeMsg(makeLongText(700)), makeMsg("recent")]
		const result = snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 1 })
		expect(result[1].content).toBe("recent")
	})

	it("compacts old long text messages", () => {
		const msgs = [makeMsg(makeLongText(1000))]
		const result = snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 0 })
		expect(result[0].content).toContain("[snip compacted")
		expect(result[0].content.length).toBeLessThan(1000)
	})

	it("leaves short messages unchanged even outside keep range", () => {
		const msgs = [makeMsg("short")]
		const result = snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 0 })
		expect(result[0].content).toBe("short")
	})

	it("handles non-string content gracefully", () => {
		const msgs = [makeMsg("" as any, { content: [1, 2, 3] as any })]
		const result = snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 0 })
		expect(result[0].content).toEqual([1, 2, 3])
	})

	it("returns original array when nothing changes", () => {
		const msgs = [makeMsg("a"), makeMsg("b")]
		expect(snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 2 })).toBe(msgs)
	})

	it("scales maxChars with hierarchy importance", () => {
		const msgs = [makeMsg(makeLongText(2000))]
		const hierarchy: ContextHierarchy = {
			turns: [{ attention: [{ self_attention_mean: 0.9 }] }],
			msgToTurnIndex: [0],
		} as any
		const result = snipCompactMessages(msgs, { contextPercent: 60, keepRecentMessages: 0 }, hierarchy)
		expect(result[0].content).toContain("[snip compacted")
	})
})
