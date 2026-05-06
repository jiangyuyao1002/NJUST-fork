import { describe, expect, it } from "vitest"

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
})
