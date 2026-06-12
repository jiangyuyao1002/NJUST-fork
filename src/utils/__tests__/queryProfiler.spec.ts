import { describe, expect, it, vi } from "vitest"

import { globalQueryProfiler } from "../queryProfiler"

describe("queryProfiler", () => {
	it("computes TTFT and E2E on finish", async () => {
		vi.useFakeTimers()
		const requestId = `req-${Date.now()}`
		globalQueryProfiler.start({
			requestId,
			taskId: "task-1",
			modelId: "model-a",
			startedAt: Date.now(),
		})

		await vi.advanceTimersByTimeAsync(5)
		globalQueryProfiler.markFirstToken(requestId)
		await vi.advanceTimersByTimeAsync(5)
		const result = globalQueryProfiler.finish(requestId)

		expect(result).toBeDefined()
		expect(result!.requestId).toBe(requestId)
		expect(result!.ttftMs).toBeTypeOf("number")
		expect(result!.e2eMs).toBeTypeOf("number")
		expect(result!.e2eMs!).toBeGreaterThanOrEqual(result!.ttftMs!)
		vi.useRealTimers()
	})

	it("returns undefined for unknown request id", () => {
		const result = globalQueryProfiler.finish("unknown-req-id")
		expect(result).toBeUndefined()
	})
})
