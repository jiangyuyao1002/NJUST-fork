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

		it("resetInstance creates a fresh singleton", () => {
			const first = TokenBucketRateLimiter.getInstance()
			TokenBucketRateLimiter.resetInstance()
			const second = TokenBucketRateLimiter.getInstance()

			expect(second).not.toBe(first)
		})
	})
})
