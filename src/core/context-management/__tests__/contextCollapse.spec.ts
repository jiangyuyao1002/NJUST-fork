import { describe, expect, it } from "vitest"
import { contextCollapseMessages } from "../contextCollapse"
import type { ApiMessage } from "../../task-persistence/apiMessages"

const m = (content: string): ApiMessage => ({ role: "user", content, ts: Date.now() })

describe("contextCollapseMessages", () => {
	it("collapses mid history when threshold exceeded", () => {
		const msgs = [m("seed"), ...Array.from({ length: 24 }, (_, i) => m(`msg-${i}`))]
		const out = contextCollapseMessages(msgs, { contextPercent: 80, triggerPercent: 70 })
		expect(out.collapsed).toBe(true)
		expect(out.messages[0].content).toBe("seed")
		expect(String(out.messages[1].content)).toContain("Context collapsed")
	})

	it("returns unchanged messages when contextPercent is below trigger threshold", () => {
		const msgs = [m("seed"), ...Array.from({ length: 24 }, (_, i) => m(`msg-${i}`))]
		const out = contextCollapseMessages(msgs, { contextPercent: 50, triggerPercent: 70 })
		expect(out.collapsed).toBe(false)
		expect(out.messages).toEqual(msgs)
	})

	it("returns unchanged messages when there are fewer than 18 messages", () => {
		const msgs = Array.from({ length: 10 }, (_, i) => m(`msg-${i}`))
		const out = contextCollapseMessages(msgs, { contextPercent: 90, triggerPercent: 70 })
		expect(out.collapsed).toBe(false)
		expect(out.messages).toHaveLength(10)
	})
})
