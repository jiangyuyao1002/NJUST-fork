import { describe, expect, it, vi } from "vitest"

import type { ClineMessage } from "@njust-ai/types"
import { cleanHistoryForResumption, getResumeAskType, checkSubtaskBudget, safeDispose } from "../TaskLifecycle"

vi.mock("../../../shared/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
		hasInstance: () => false,
		instance: { captureEvent: vi.fn() },
	},
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _id = 0
function msg(overrides: Partial<ClineMessage> & { type: "ask" | "say" }): ClineMessage {
	_id++
	return {
		id: `msg-${_id}`,
		ts: Date.now() + _id,
		...overrides,
	} as ClineMessage
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("cleanHistoryForResumption", () => {
	it("removes trailing resume_task / resume_completed_task messages", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "ask", ask: "resume_task" }),
			msg({ type: "ask", ask: "resume_completed_task" }),
		]

		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(1)
		expect(result[0]!.say).toBe("text")
	})

	it("removes trailing reasoning messages", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "answer" }),
			msg({ type: "say", say: "reasoning", text: "thinking..." }),
			msg({ type: "say", say: "reasoning", text: "more thinking..." }),
		]

		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(1)
		expect(result[0]!.say).toBe("text")
	})

	it("removes incomplete API requests (no cost, no cancelReason)", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "say", say: "api_req_started", text: JSON.stringify({ request: "some request" }) }),
		]

		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(1)
		expect(result[0]!.say).toBe("text")
	})

	it("keeps complete API requests (with cost)", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.05, request: "x" }) }),
		]

		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(2)
		expect(result[1]!.say).toBe("api_req_started")
	})

	it("keeps API requests with cancelReason", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ cancelReason: "user_cancelled" }),
			}),
		]

		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(2)
		expect(result[1]!.say).toBe("api_req_started")
	})

	it("handles empty messages array", () => {
		const result = cleanHistoryForResumption([])
		expect(result).toEqual([])
	})

	it("handles JSON parse failure gracefully", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "say", say: "api_req_started", text: "NOT-VALID-JSON{{{" }),
		]

		// Should not throw; leaves the malformed message as-is.
		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(2)
		expect(result[1]!.say).toBe("api_req_started")
	})

	it("handles api_req_started with empty / missing text", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "say", say: "api_req_started", text: undefined }),
		]

		// JSON.parse("{}") → {} → cost is undefined, cancelReason is undefined → removed
		const result = cleanHistoryForResumption(messages)

		expect(result).toHaveLength(1)
		expect(result[0]!.say).toBe("text")
	})

	it("removes resume messages, then reasoning, then checks api_req in sequence", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "base" }),
			msg({ type: "say", say: "api_req_started", text: JSON.stringify({}) }),
			msg({ type: "say", say: "reasoning", text: "think" }),
			msg({ type: "ask", ask: "resume_task" }),
		]

		const result = cleanHistoryForResumption(messages)

		// resume removed → reasoning removed → api_req (incomplete) removed → only "text" left
		expect(result).toHaveLength(1)
		expect(result[0]!.say).toBe("text")
	})
})

describe("getResumeAskType", () => {
	it('returns "resume_completed_task" when last meaningful message has ask=completion_result', () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "done" }),
			msg({ type: "ask", ask: "completion_result" }),
			msg({ type: "ask", ask: "resume_task" }),
		]

		expect(getResumeAskType(messages)).toBe("resume_completed_task")
	})

	it('returns "resume_task" when last meaningful message is not completion_result', () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "working..." }),
			msg({ type: "ask", ask: "command" }),
			msg({ type: "ask", ask: "resume_task" }),
		]

		expect(getResumeAskType(messages)).toBe("resume_task")
	})

	it('returns "resume_task" when all messages are resume messages (no meaningful message found)', () => {
		const messages: ClineMessage[] = [
			msg({ type: "ask", ask: "resume_task" }),
			msg({ type: "ask", ask: "resume_completed_task" }),
		]

		// lastMeaningful is undefined → defaults to "resume_task"
		expect(getResumeAskType(messages)).toBe("resume_task")
	})

	it('returns "resume_task" for an empty array', () => {
		expect(getResumeAskType([])).toBe("resume_task")
	})

	it("skips trailing resume_completed_task when looking for meaningful message", () => {
		const messages: ClineMessage[] = [
			msg({ type: "say", say: "text", text: "done" }),
			msg({ type: "ask", ask: "completion_result" }),
			msg({ type: "ask", ask: "resume_completed_task" }),
		]

		// lastMeaningful is the completion_result one (skipping the resume_completed_task)
		expect(getResumeAskType(messages)).toBe("resume_completed_task")
	})
})

describe("checkSubtaskBudget", () => {
	it("returns safe status when under threshold", () => {
		// parentRemaining = 200000 - 100000 = 100000
		// usagePercent = 10000 / 100000 = 0.1 (10%)
		const result = checkSubtaskBudget(10_000, 100_000, 200_000)

		expect(result.isApproachingLimit).toBe(false)
		expect(result.subtaskTokens).toBe(10_000)
		expect(result.parentRemaining).toBe(100_000)
		expect(result.usagePercent).toBeCloseTo(0.1)
	})

	it("returns warning when over default 80% threshold", () => {
		// parentRemaining = 200000 - 100000 = 100000
		// usagePercent = 90000 / 100000 = 0.9 (90%)
		const result = checkSubtaskBudget(90_000, 100_000, 200_000)

		expect(result.isApproachingLimit).toBe(true)
		expect(result.usagePercent).toBeCloseTo(0.9)
	})

	it("returns critical status at exactly 100%", () => {
		// parentRemaining = 200000 - 100000 = 100000
		// usagePercent = 100000 / 100000 = 1.0 (100%)
		const result = checkSubtaskBudget(100_000, 100_000, 200_000)

		expect(result.isApproachingLimit).toBe(true)
		expect(result.usagePercent).toBe(1)
	})

	it("returns isApproachingLimit=true when parentRemaining is 0", () => {
		// parentRemaining = 100000 - 100000 = 0
		// usagePercent = parentRemaining === 0 → 1 (100%)
		const result = checkSubtaskBudget(5_000, 100_000, 100_000)

		expect(result.isApproachingLimit).toBe(true)
		expect(result.parentRemaining).toBe(0)
		expect(result.usagePercent).toBe(1)
	})

	it("respects custom warningThreshold", () => {
		// parentRemaining = 100000
		// usagePercent = 60000 / 100000 = 0.6 (60%)
		// threshold = 0.5 → over threshold
		const result = checkSubtaskBudget(60_000, 100_000, 200_000, 0.5)

		expect(result.isApproachingLimit).toBe(true)
	})

	it("does not trigger when exactly at threshold", () => {
		// parentRemaining = 100000
		// usagePercent = 80000 / 100000 = 0.8
		// threshold = 0.8 → usagePercent > 0.8 is false
		const result = checkSubtaskBudget(80_000, 100_000, 200_000, 0.8)

		expect(result.isApproachingLimit).toBe(false)
	})
})

describe("safeDispose", () => {
	it("executes the function successfully when no error", () => {
		const fn = vi.fn()

		safeDispose("test-label", fn)

		expect(fn).toHaveBeenCalledOnce()
	})

	it("catches errors without throwing and logs them", async () => {
		const { logger } = await import("../../../shared/logger")
		const { TelemetryService } = await import("@njust-ai/telemetry")

		const testError = new Error("dispose failed")
		const fn = vi.fn(() => {
			throw testError
		})

		// Should not throw
		expect(() => safeDispose("cleanup-step", fn)).not.toThrow()

		expect(fn).toHaveBeenCalledOnce()
		expect(logger.error).toHaveBeenCalledWith("TaskLifecycle", `Error during dispose (cleanup-step):`, testError)
		expect(TelemetryService.reportError).toHaveBeenCalledWith(testError, "utility_error")
	})

	it("wraps non-Error throws in Error for telemetry", async () => {
		const { TelemetryService } = await import("@njust-ai/telemetry")

		const fn = vi.fn(() => {
			throw "string-error"
		})

		expect(() => safeDispose("string-throw", fn)).not.toThrow()

		expect(TelemetryService.reportError).toHaveBeenCalled()
		// The first argument should be wrapped in Error(String(error))
		const call = (TelemetryService.reportError as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
		expect(call[0]).toBeInstanceOf(Error)
		expect(call[0].message).toBe("string-error")
	})
})
