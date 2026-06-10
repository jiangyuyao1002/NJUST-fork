import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PersistentRetryManager } from "../PersistentRetry"

describe("PersistentRetryManager", () => {
	beforeEach(() => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("allows retries then blocks after per-category limit", () => {
		const manager = new PersistentRetryManager({
			maxPerCategoryRetries: { timeout: 2 },
			maxTotalRetries: 10,
		})

		expect(manager.canRetry("timeout").allowed).toBe(true)
		manager.recordRetry("timeout", 1000)
		expect(manager.canRetry("timeout").allowed).toBe(true)
		manager.recordRetry("timeout", 2000)

		const result = manager.canRetry("timeout")
		expect(result.allowed).toBe(false)
		expect(result.shouldFallback).toBe(true)
		expect(result.reason).toContain("retry limit reached")
	})

	it("blocks after total retry limit", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 2 })
		manager.recordRetry("unknown", 100)
		manager.recordRetry("connection", 100)

		const result = manager.canRetry("connection")
		expect(result.allowed).toBe(false)
		expect(result.reason).toContain("Total retry limit reached")
	})

	it("computes exponential suggested delay by category", () => {
		const manager = new PersistentRetryManager()
		const first = manager.canRetry("model_overloaded")
		expect(first.suggestedDelayMs).toBe(5000)
		manager.recordRetry("model_overloaded", first.suggestedDelayMs)
		const second = manager.canRetry("model_overloaded")
		expect(second.suggestedDelayMs).toBe(10000)
	})

	it("resets all counters", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 3 })
		manager.recordRetry("rate_limit", 500)
		manager.recordRetry("rate_limit", 1000)
		expect(manager.getStats().totalRetries).toBe(2)
		manager.reset()
		const stats = manager.getStats()
		expect(stats.totalRetries).toBe(0)
		expect(stats.records.size).toBe(0)
	})

	it("isEligible matches canRetry().allowed", () => {
		const manager = new PersistentRetryManager({ maxPerCategoryRetries: { timeout: 1 }, maxTotalRetries: 10 })
		expect(manager.isEligible("timeout")).toBe(true)
		manager.recordRetry("timeout", 100)
		expect(manager.isEligible("timeout")).toBe(false)
	})

	it("getStats().isExhausted is false when retries remain", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 5 })
		manager.recordRetry("timeout", 100)
		expect(manager.getStats().isExhausted).toBe(false)
	})

	it("getStats().isExhausted is true when retries exhausted", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 2 })
		manager.recordRetry("timeout", 100)
		manager.recordRetry("timeout", 100)
		expect(manager.getStats().isExhausted).toBe(true)
	})

	it("default config has maxTotalRetries=30", () => {
		const manager = new PersistentRetryManager({})
		for (let i = 0; i < 30; i++) {
			manager.recordRetry("timeout", 100)
		}
		expect(manager.getStats().isExhausted).toBe(true)
	})

	it("partial config merges with defaults", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 5 })
		for (let i = 0; i < 4; i++) {
			manager.recordRetry("timeout", 100)
		}
		expect(manager.canRetry("timeout").allowed).toBe(true)
		manager.recordRetry("timeout", 100)
		expect(manager.getStats().isExhausted).toBe(true)
	})

	it("per-category counters are independent", () => {
		const manager = new PersistentRetryManager({
			maxPerCategoryRetries: { timeout: 2, rate_limit: 2 },
			maxTotalRetries: 100,
		})
		manager.recordRetry("timeout", 100)
		manager.recordRetry("timeout", 100)
		expect(manager.canRetry("timeout").allowed).toBe(false)
		expect(manager.canRetry("rate_limit").allowed).toBe(true)
	})

	it("unknown error category defaults to limit 3", () => {
		const manager = new PersistentRetryManager({ maxTotalRetries: 100 })
		manager.recordRetry("foobar", 100)
		manager.recordRetry("foobar", 100)
		expect(manager.canRetry("foobar").allowed).toBe(true)
		manager.recordRetry("foobar", 100)
		expect(manager.canRetry("foobar").allowed).toBe(false)
	})

	it("unknown category uses base delay 1000ms", () => {
		const manager = new PersistentRetryManager()
		const result = manager.canRetry("nonexistent_category")
		expect(result.suggestedDelayMs).toBe(1000)
	})

	it("recordRetry updates firstOccurrence and lastOccurrence", () => {
		const now = 1000000
		const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now)
		const manager = new PersistentRetryManager()
		manager.recordRetry("timeout", 500)
		const record = manager.getStats().records.get("timeout")!
		expect(record.firstOccurrence).toBe(now)
		expect(record.lastOccurrence).toBe(now)
		dateSpy.mockReturnValue(now + 5000)
		manager.recordRetry("timeout", 500)
		expect(record.firstOccurrence).toBe(now)
		expect(record.lastOccurrence).toBe(now + 5000)
	})

	it("recordRetry accumulates totalDelayMs", () => {
		const manager = new PersistentRetryManager()
		manager.recordRetry("timeout", 1000)
		manager.recordRetry("timeout", 2000)
		const record = manager.getStats().records.get("timeout")!
		expect(record.totalDelayMs).toBe(3000)
	})

	it("recordRetry increments totalRetries counter", () => {
		const manager = new PersistentRetryManager()
		manager.recordRetry("timeout", 100)
		manager.recordRetry("rate_limit", 200)
		expect(manager.getStats().totalRetries).toBe(2)
	})

	it("shouldFallback is false when retries remain", () => {
		const manager = new PersistentRetryManager()
		const result = manager.canRetry("timeout")
		expect(result.allowed).toBe(true)
		expect(result.shouldFallback).toBe(false)
	})

	it("shouldFallback is true when category limit reached", () => {
		const manager = new PersistentRetryManager({
			maxPerCategoryRetries: { timeout: 1 },
			maxTotalRetries: 100,
		})
		manager.recordRetry("timeout", 100)
		const result = manager.canRetry("timeout")
		expect(result.shouldFallback).toBe(true)
	})

	it("jitter bounds: Math.random=0 gives 0.75x rawDelay", () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const manager = new PersistentRetryManager()
		const result = manager.canRetry("timeout")
		expect(result.suggestedDelayMs).toBe(Math.round(2000 * 0.75))
	})

	it("jitter bounds: Math.random=1 gives 1.25x rawDelay", () => {
		vi.spyOn(Math, "random").mockReturnValue(1)
		const manager = new PersistentRetryManager()
		const result = manager.canRetry("timeout")
		expect(result.suggestedDelayMs).toBe(Math.round(2000 * 1.25))
	})

	it("MAX_EXPONENT=12 caps delay growth", () => {
		const manager = new PersistentRetryManager({
			maxPerCategoryRetries: { timeout: 20 },
			maxTotalRetries: 100,
		})
		for (let i = 0; i < 15; i++) {
			manager.recordRetry("timeout", 100)
		}
		const result = manager.canRetry("timeout")
		const maxExpected = Math.round(2000 * Math.pow(2, 12) * 1.25)
		expect(result.suggestedDelayMs).toBeLessThanOrEqual(maxExpected)
	})

	it("MAX_SUGGESTED_DELAY_MS caps at 120000", () => {
		const manager = new PersistentRetryManager({
			maxPerCategoryRetries: { timeout: 20 },
			maxTotalRetries: 100,
		})
		for (let i = 0; i < 20; i++) {
			manager.recordRetry("timeout", 100)
		}
		const result = manager.canRetry("timeout")
		expect(result.suggestedDelayMs).toBeLessThanOrEqual(Math.round(120000 * 1.25))
	})

	it("canRetry returns reason string on success", () => {
		const manager = new PersistentRetryManager()
		const result = manager.canRetry("timeout")
		expect(result.reason).toContain("Retry allowed")
		expect(result.reason).toContain("timeout")
	})

	describe("waitForRetry", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		it("resolves after suggested delay", async () => {
			const manager = new PersistentRetryManager({ maxTotalRetries: 10 })
			const promise = manager.waitForRetry("timeout")
			vi.advanceTimersByTime(3000)
			await promise
			expect(manager.getStats().totalRetries).toBe(1)
		})

		it("calls heartbeat before waiting", async () => {
			const manager = new PersistentRetryManager({ maxTotalRetries: 10 })
			const heartbeat = vi.fn()
			const promise = manager.waitForRetry("timeout", heartbeat)
			expect(heartbeat).toHaveBeenCalledTimes(1)
			expect(heartbeat).toHaveBeenCalledWith(expect.stringContaining("timeout"), 1, expect.any(Number))
			vi.advanceTimersByTime(3000)
			await promise
		})

		it("rejects when cancelled", async () => {
			const manager = new PersistentRetryManager({ maxTotalRetries: 10 })
			const promise = manager.waitForRetry("timeout")
			manager.cancel()
			vi.advanceTimersByTime(1000)
			await expect(promise).rejects.toThrow("Persistent retry cancelled")
		})

		it("rejects when retries exhausted", async () => {
			const manager = new PersistentRetryManager({
				maxPerCategoryRetries: { timeout: 0 },
				maxTotalRetries: 10,
			})
			await expect(manager.waitForRetry("timeout")).rejects.toThrow()
		})
	})

	describe("quiet window auto-reset", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})
		afterEach(() => {
			vi.useRealTimers()
		})

		it("resets counters after quiet window elapses", () => {
			const now = 1000000
			vi.spyOn(Date, "now").mockReturnValue(now)
			const manager = new PersistentRetryManager({ resetWindowMs: 5000, maxTotalRetries: 100 })
			manager.recordRetry("timeout", 100)
			expect(manager.getStats().totalRetries).toBe(1)

			vi.spyOn(Date, "now").mockReturnValue(now + 5001)
			expect(manager.canRetry("timeout").allowed).toBe(true)
			expect(manager.getStats().totalRetries).toBe(0)
		})

		it("does not reset if quiet window not elapsed", () => {
			const now = 1000000
			vi.spyOn(Date, "now").mockReturnValue(now)
			const manager = new PersistentRetryManager({ resetWindowMs: 5000, maxTotalRetries: 100 })
			manager.recordRetry("timeout", 100)
			expect(manager.getStats().totalRetries).toBe(1)

			vi.spyOn(Date, "now").mockReturnValue(now + 4000)
			expect(manager.canRetry("timeout").allowed).toBe(true)
			expect(manager.getStats().totalRetries).toBe(1)
		})

		it("recordSuccess updates lastErrorTime for quiet window", () => {
			const now = 1000000
			vi.spyOn(Date, "now").mockReturnValue(now)
			const manager = new PersistentRetryManager({ resetWindowMs: 5000, maxTotalRetries: 100 })
			manager.recordRetry("timeout", 100)
			expect(manager.getStats().totalRetries).toBe(1)

			vi.spyOn(Date, "now").mockReturnValue(now + 3000)
			manager.recordSuccess()

			vi.spyOn(Date, "now").mockReturnValue(now + 3000 + 4999)
			expect(manager.canRetry("timeout").allowed).toBe(true)
			expect(manager.getStats().totalRetries).toBe(1)

			vi.spyOn(Date, "now").mockReturnValue(now + 3000 + 5001)
			expect(manager.canRetry("timeout").allowed).toBe(true)
			expect(manager.getStats().totalRetries).toBe(0)
		})
	})

	describe("default category limits", () => {
		const defaults: Record<string, number> = {
			rate_limit: 15,
			capacity: 10,
			model_overloaded: 8,
			timeout: 5,
			connection: 10,
			server_error: 5,
			unknown: 3,
		}
		for (const [category, limit] of Object.entries(defaults)) {
			it(`${category} limit is ${limit}`, () => {
				const manager = new PersistentRetryManager()
				for (let i = 0; i < limit; i++) {
					expect(manager.canRetry(category).allowed).toBe(true)
					manager.recordRetry(category, 100)
				}
				expect(manager.canRetry(category).allowed).toBe(false)
			})
		}
	})
})
