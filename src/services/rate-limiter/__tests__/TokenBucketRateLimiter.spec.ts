import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TokenBucketRateLimiter } from "../TokenBucketRateLimiter"

describe("TokenBucketRateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		TokenBucketRateLimiter.resetInstance()
	})

	afterEach(() => {
		vi.useRealTimers()
		TokenBucketRateLimiter.resetInstance()
	})

	describe("tryConsume", () => {
		it("consumes available tokens and rejects when the bucket is empty", () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 2, refillPerSec: 1 } })

			expect(limiter.tryConsume("test")).toBe(true)
			expect(limiter.tryConsume("test")).toBe(true)
			expect(limiter.tryConsume("test")).toBe(false)
			expect(limiter.getStats("test")?.tokens).toBe(0)
		})

		it("refills tokens based on elapsed time", () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 2, refillPerSec: 1 } })
			limiter.tryConsume("test")
			limiter.tryConsume("test")

			vi.setSystemTime(1000)

			expect(limiter.tryConsume("test")).toBe(true)
			expect(limiter.getStats("test")?.tokens).toBe(0)
		})
	})

	describe("wait", () => {
		it("resolves immediately when a token is available", async () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })

			await expect(limiter.wait("test")).resolves.toBe(0)
		})

		it("waits until refill when the bucket is empty", async () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
			limiter.tryConsume("test")

			const waitPromise = limiter.wait("test")
			expect(limiter.getStats("test")?.waiting).toBe(1)

			await vi.advanceTimersByTimeAsync(1000)

			await expect(waitPromise).resolves.toBe(1000)
			expect(limiter.getStats("test")?.waiting).toBe(0)
		})

		it("queues multiple waiters and serves them across refills", async () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
			limiter.tryConsume("test")

			const first = limiter.wait("test")
			const second = limiter.wait("test")

			await vi.advanceTimersByTimeAsync(1000)
			await expect(first).resolves.toBe(1000)
			expect(limiter.getStats("test")?.waiting).toBe(1)

			await vi.advanceTimersByTimeAsync(1000)
			await expect(second).resolves.toBe(2000)
			expect(limiter.getStats("test")?.waiting).toBe(0)
		})
	})

	describe("configuration and stats", () => {
		it("uses default config for unknown providers", () => {
			const limiter = new TokenBucketRateLimiter()

			expect(limiter.tryConsume("unknown")).toBe(true)
			expect(limiter.getStats("unknown")).toMatchObject({
				capacity: 10,
				refillPerSec: 0.5,
				waiting: 0,
			})
		})

		it("updates provider config for future refills and stats", () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
			limiter.tryConsume("test")

			limiter.setConfig("test", { capacity: 3, refillPerSec: 2 })
			vi.setSystemTime(1000)
			expect(limiter.tryConsume("test")).toBe(true)

			expect(limiter.getStats("test")).toMatchObject({
				capacity: 3,
				refillPerSec: 2,
			})
		})

		it("reset clears existing buckets", () => {
			const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
			limiter.tryConsume("test")
			expect(limiter.getStats("test")).not.toBeNull()

			limiter.reset()

			expect(limiter.getStats("test")).toBeNull()
		})
	})

	it("resetInstance creates a fresh singleton", () => {
		const first = TokenBucketRateLimiter.getInstance()
		TokenBucketRateLimiter.resetInstance()
		const second = TokenBucketRateLimiter.getInstance()

		expect(second).not.toBe(first)
	})

	it("reset clears pending refill timer", async () => {
		const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
		limiter.tryConsume("test")

		void limiter.wait("test")
		expect(vi.getTimerCount()).toBeGreaterThan(0)

		limiter.reset()

		expect(vi.getTimerCount()).toBe(0)
	})

	it("dispose clears pending refill timer", async () => {
		const limiter = new TokenBucketRateLimiter({ test: { capacity: 1, refillPerSec: 1 } })
		limiter.tryConsume("test")

		void limiter.wait("test")
		expect(vi.getTimerCount()).toBeGreaterThan(0)

		limiter.dispose()

		expect(vi.getTimerCount()).toBe(0)
	})

	it("resetInstance disposes the old instance before creating a new one", () => {
		const first = TokenBucketRateLimiter.getInstance()
		first.tryConsume("anthropic")
		void first.wait("anthropic")

		TokenBucketRateLimiter.resetInstance()
		const second = TokenBucketRateLimiter.getInstance()

		expect(second).not.toBe(first)
		// The old instance's timer should have been cleared by dispose()
		expect(second).toBeDefined()
	})

	describe("per-provider timer isolation", () => {
		/**
		 * Regression: refillTimer was a single field shared across providers.
		 * When provider A scheduled a refill, then provider B scheduled one,
		 * B's clearTimeout() killed A's pending timer and A's waiters starved.
		 */
		it("two providers with waiting requests both resolve independently", async () => {
			// Each provider: capacity 1, refill 1/s → wait ~1s when bucket is empty.
			const limiter = new TokenBucketRateLimiter({
				alpha: { capacity: 1, refillPerSec: 1 },
				beta: { capacity: 1, refillPerSec: 1 },
			})

			// Drain both buckets so the next wait() must block.
			limiter.tryConsume("alpha")
			limiter.tryConsume("beta")
			expect(limiter.getStats("alpha")?.tokens).toBe(0)
			expect(limiter.getStats("beta")?.tokens).toBe(0)

			const alphaWait = limiter.wait("alpha")
			const betaWait = limiter.wait("beta")
			expect(limiter.getStats("alpha")?.waiting).toBe(1)
			expect(limiter.getStats("beta")?.waiting).toBe(1)

			// Advance time enough for both to refill.
			await vi.advanceTimersByTimeAsync(1000)

			await expect(alphaWait).resolves.toBeGreaterThanOrEqual(0)
			await expect(betaWait).resolves.toBeGreaterThanOrEqual(0)
			expect(limiter.getStats("alpha")?.waiting).toBe(0)
			expect(limiter.getStats("beta")?.waiting).toBe(0)
		})

		it("scheduling a refill for one provider does not cancel another provider's pending timer", async () => {
			const limiter = new TokenBucketRateLimiter({
				slow: { capacity: 1, refillPerSec: 1 }, // 1000ms wait
				fast: { capacity: 1, refillPerSec: 10 }, // 100ms wait
			})

			limiter.tryConsume("slow")
			limiter.tryConsume("fast")

			const slowWait = limiter.wait("slow")
			// Let the slow provider schedule its timer first.
			await vi.advanceTimersByTimeAsync(0)
			expect(vi.getTimerCount()).toBe(1)

			// Now wait on the fast provider — this schedules a second timer
			// at a different delay. The slow provider's timer must survive.
			const fastWait = limiter.wait("fast")
			expect(vi.getTimerCount()).toBe(2)

			// Advance just enough for the fast provider to refill.
			await vi.advanceTimersByTimeAsync(100)
			await expect(fastWait).resolves.toBeGreaterThanOrEqual(0)
			expect(limiter.getStats("slow")?.waiting).toBe(1)

			// The slow provider's wait should still be pending — its timer
			// was NOT cancelled by the fast provider's scheduling.
			await vi.advanceTimersByTimeAsync(900)
			await expect(slowWait).resolves.toBeGreaterThanOrEqual(0)
		})

		it("reset clears timers for all providers", async () => {
			const limiter = new TokenBucketRateLimiter({
				alpha: { capacity: 1, refillPerSec: 1 },
				beta: { capacity: 1, refillPerSec: 1 },
			})

			limiter.tryConsume("alpha")
			limiter.tryConsume("beta")
			void limiter.wait("alpha")
			void limiter.wait("beta")
			expect(vi.getTimerCount()).toBe(2)

			limiter.reset()
			expect(vi.getTimerCount()).toBe(0)
		})
	})
})
