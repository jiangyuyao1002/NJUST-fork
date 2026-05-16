import { describe, expect, it, vi } from "vitest"

import { computeContextPressure, RequestRateLimiter, TokenUsageTracker, validateConversationHistory } from "../ApiRequestHandler"
import { PermissionContext } from "../../tools/permissions/PermissionContext"

describe("RequestRateLimiter", () => {
	it("waits only when requests are inside the configured delay", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1000)
		const limiter = new RequestRateLimiter(100)

		await expect(limiter.waitIfNeeded()).resolves.toBeUndefined()
		limiter.markRequestSent()
		vi.setSystemTime(1050)
		const wait = limiter.waitIfNeeded()
		await vi.advanceTimersByTimeAsync(50)

		await expect(wait).resolves.toBeUndefined()
		expect(limiter.getLastRequestTime()).toBe(1000)
		vi.useRealTimers()
	})
})

describe("TokenUsageTracker", () => {
	it("caches usage until stale or invalidated", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1000)
		const tracker = new TokenUsageTracker(100)
		const compute = vi
			.fn()
			.mockReturnValueOnce({ totalTokensIn: 1, totalTokensOut: 2, totalCost: 3 })
			.mockReturnValueOnce({ totalTokensIn: 4, totalTokensOut: 5, totalCost: 6 })
			.mockReturnValueOnce({ totalTokensIn: 10, totalTokensOut: 11, totalCost: 12 })

		expect(tracker.getUsage(compute).totalTokensIn).toBe(1)
		expect(tracker.getUsage(compute).totalTokensIn).toBe(1)
		vi.setSystemTime(1200)
		expect(tracker.getUsage(compute).totalTokensIn).toBe(4)
		tracker.forceUpdate({ totalTokensIn: 7, totalTokensOut: 8, totalCost: 9 })
		expect(tracker.getUsage(compute).totalTokensIn).toBe(7)
		tracker.invalidate()
		expect(tracker.getUsage(compute).totalTokensIn).toBe(10)
		vi.useRealTimers()
	})
})

describe("computeContextPressure", () => {
	it.each([
		[850, 1000, 80, true, true],
		[680, 1000, 80, false, true],
		[500, 1000, 80, false, false],
		[500, 0, 80, false, false],
	] as const)("computes pressure for %s/%s", (current, window, threshold, high, compact) => {
		expect(computeContextPressure(current, window, threshold)).toMatchObject({
			currentTokens: current,
			contextWindow: window,
			isHighPressure: high,
			shouldPreemptivelyCompact: compact,
		})
	})
})

describe("validateConversationHistory", () => {
	it("accepts empty and alternating histories", () => {
		expect(validateConversationHistory([])).toEqual({ valid: true, errors: [] })
		expect(
			validateConversationHistory([
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			]),
		).toEqual({ valid: true, errors: [] })
	})

	it("reports invalid first role and consecutive user messages", () => {
		const result = validateConversationHistory([
			{ role: "assistant", content: "hi" },
			{ role: "user", content: "one" },
			{ role: "user", content: [{ type: "text", text: "two" }] },
		])

		expect(result.valid).toBe(false)
		expect(result.errors).toContain("First message should be from user role")
		expect(result.errors).toContain("Consecutive user messages at index 1 and 2")
	})

	it("allows consecutive user messages when the later one contains tool_result", () => {
		expect(
			validateConversationHistory([
				{ role: "user", content: "run" },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
			]).valid,
		).toBe(true)
	})
})

describe("PermissionContext", () => {
	it("resolves only once and exposes shorthand decisions", async () => {
		const context = new PermissionContext()
		const wait = context.waitForDecision()

		expect(context.allow("hook", "ok")).toBe(true)
		expect(context.deny("ui", "late")).toBe(false)
		await expect(wait).resolves.toEqual({ decision: "allow", source: "hook", message: "ok" })
		expect(context.result?.decision).toBe("allow")
		expect(context.isResolved).toBe(true)
	})

	it("times out with the default decision", async () => {
		vi.useFakeTimers()
		const context = new PermissionContext()
		const wait = context.waitForDecisionWithTimeout(100, "abort")
		await vi.advanceTimersByTimeAsync(100)

		await expect(wait).resolves.toMatchObject({
			decision: "abort",
			source: "auto_approval",
		})
		vi.useRealTimers()
	})

	it("disposes pending callbacks without resolving", () => {
		const context = new PermissionContext()
		void context.waitForDecision()

		context.dispose()

		expect(context.isResolved).toBe(false)
		expect(context.abort("remote")).toBe(true)
	})
})
