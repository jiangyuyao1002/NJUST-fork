import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiRetryExecutor, DEFAULT_API_RETRY_OPTIONS, computeBackoffMs, delayMs } from "../ApiRetryStrategy"

describe("computeBackoffMs", () => {
	const opts = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000, jitterRatio: 0 }

	afterEach(() => vi.restoreAllMocks())

	it("exponential growth: attempt 0 → baseDelay", () => {
		expect(computeBackoffMs(0, opts)).toBe(1000)
	})

	it("exponential growth: attempt 1 → 2x", () => {
		expect(computeBackoffMs(1, opts)).toBe(2000)
	})

	it("exponential growth: attempt 2 → 4x", () => {
		expect(computeBackoffMs(2, opts)).toBe(4000)
	})

	it("capped at maxDelayMs", () => {
		const smallMax = { ...opts, maxDelayMs: 3000 }
		expect(computeBackoffMs(5, smallMax)).toBe(3000)
	})

	it("retryAfterSeconds overrides exponential", () => {
		expect(computeBackoffMs(0, opts, 5)).toBe(5000)
	})

	it("retryAfterSeconds capped at maxDelayMs", () => {
		expect(computeBackoffMs(0, opts, 120)).toBe(60_000)
	})

	it("retryAfterSeconds=0 returns 0 (honors explicit zero delay)", () => {
		expect(computeBackoffMs(0, opts, 0)).toBe(0)
	})

	it("negative attempt clamped to 0", () => {
		expect(computeBackoffMs(-1, opts)).toBe(1000)
	})

	it("jitter shifts result within ratio", () => {
		const jitterOpts = { ...opts, jitterRatio: 0.5 }
		vi.spyOn(Math, "random").mockReturnValue(1)
		const high = computeBackoffMs(0, jitterOpts)
		vi.spyOn(Math, "random").mockReturnValue(0)
		const low = computeBackoffMs(0, jitterOpts)
		expect(low).toBe(500)
		expect(high).toBe(1500)
	})

	it("result is never negative", () => {
		const negJitter = { ...opts, jitterRatio: 10 }
		vi.spyOn(Math, "random").mockReturnValue(0)
		const result = computeBackoffMs(0, negJitter)
		expect(result).toBeGreaterThanOrEqual(0)
	})
})

describe("DEFAULT_API_RETRY_OPTIONS", () => {
	it("has expected values", () => {
		expect(DEFAULT_API_RETRY_OPTIONS.maxAttempts).toBe(4)
		expect(DEFAULT_API_RETRY_OPTIONS.baseDelayMs).toBe(1000)
		expect(DEFAULT_API_RETRY_OPTIONS.maxDelayMs).toBe(60_000)
		expect(DEFAULT_API_RETRY_OPTIONS.jitterRatio).toBe(0.1)
	})
})

describe("delayMs", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("resolves after specified ms", async () => {
		const promise = delayMs(500)
		vi.advanceTimersByTime(500)
		await promise
	})
})

describe("ApiRetryExecutor", () => {
	it("returns result on first success", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		const result = await executor.execute(async () => 42)
		expect(result).toBe(42)
	})

	it("retries and succeeds on later attempt", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		let call = 0
		const result = await executor.execute(async () => {
			call++
			if (call < 3) throw new Error("fail")
			return "ok"
		})
		expect(result).toBe("ok")
		expect(call).toBe(3)
	})

	it("throws last error after maxAttempts exhausted", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		await expect(
			executor.execute(async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")
	})

	it("stops when shouldRetry returns false", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		let calls = 0
		await expect(
			executor.execute(
				async () => {
					calls++
					throw new Error("nope")
				},
				() => ({ retry: false }),
			),
		).rejects.toThrow("nope")
		expect(calls).toBe(1)
	})

	it("retries by default when shouldRetry omitted", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		let calls = 0
		await expect(
			executor.execute(async () => {
				calls++
				throw new Error("fail")
			}),
		).rejects.toThrow("fail")
		expect(calls).toBe(3)
	})

	it("fires onRetry callback before each retry delay", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		const onRetry = vi.fn()
		let calls = 0
		await executor.execute(
			async () => {
				calls++
				if (calls < 3) throw new Error("fail")
				return "done"
			},
			() => ({ retry: true }),
			onRetry,
		)
		expect(onRetry).toHaveBeenCalledTimes(2)
		expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 0, error: expect.any(Error) }))
	})

	it("maxAttempts=1 does not retry", async () => {
		const executor = new ApiRetryExecutor({ maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
		let calls = 0
		await expect(
			executor.execute(async () => {
				calls++
				throw new Error("once")
			}),
		).rejects.toThrow("once")
		expect(calls).toBe(1)
	})
})
