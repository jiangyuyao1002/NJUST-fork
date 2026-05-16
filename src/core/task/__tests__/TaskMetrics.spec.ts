import { describe, expect, it, vi } from "vitest"

import { TaskMetricsCollector } from "../TaskMetrics"

describe("TaskMetricsCollector", () => {
	it("records metrics and exports a report", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1000)
		const metrics = new TaskMetricsCollector()

		vi.setSystemTime(3500)
		metrics.recordToolExecution("read_file", 10)
		metrics.recordToolExecution("read_file", 30)
		metrics.recordApiLatency(100)
		metrics.recordApiLatency(300)
		metrics.recordContextSwitch()
		metrics.recordErrorRecovery("rate_limit")
		metrics.updateConcurrency(2)
		metrics.updateConcurrency(5)
		metrics.updateConcurrency(3)
		metrics.updateTokensUsed(1234)
		metrics.updateCacheHitRate(0.25)
		metrics.markEnded()

		const snapshot = metrics.getMetrics()
		const report = metrics.exportReport()

		expect(snapshot.maxConcurrencyReached).toBe(5)
		expect(snapshot.totalTokensUsed).toBe(1234)
		expect(report).toContain("Duration: 2.5s")
		expect(report).toContain("Avg API Latency: 200ms")
		expect(report).toContain("read_file: 2 calls, avg 20ms")
		expect(report).toContain("rate_limit: 1 recoveries")
		vi.useRealTimers()
	})

	it("exports an empty report without optional sections", () => {
		const metrics = new TaskMetricsCollector()

		const report = metrics.exportReport()

		expect(report).toContain("Total API Requests: 0")
		expect(report).not.toContain("Tool Execution Summary")
		expect(report).not.toContain("Error Recovery")
	})
})
