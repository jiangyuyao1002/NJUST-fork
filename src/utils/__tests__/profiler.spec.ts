import { describe, expect, it } from "vitest"

import { startupProfiler } from "../profiler"

describe("startupProfiler", () => {
	it("records start/end duration", async () => {
		const name = `activate-${Date.now()}`
		startupProfiler.start(name)
		await new Promise((r) => setTimeout(r, 3))
		startupProfiler.end(name)

		const summary = startupProfiler.summary()
		const entry = summary.find((e) => e.name === name)
		expect(entry).toBeDefined()
		expect(entry!.startedAt).toBeTypeOf("number")
		expect(entry!.endedAt).toBeTypeOf("number")
		expect(entry!.durationMs).toBeTypeOf("number")
		expect(entry!.durationMs!).toBeGreaterThanOrEqual(0)
	})

	it("measure() records duration and returns result", async () => {
		const name = `measure-ok-${Date.now()}`
		const result = await startupProfiler.measure(name, async () => {
			await new Promise((r) => setTimeout(r, 3))
			return 42
		})

		expect(result).toBe(42)

		const entry = startupProfiler.summary().find((e) => e.name === name)
		expect(entry).toBeDefined()
		expect(entry!.durationMs).toBeGreaterThanOrEqual(0)
	})

	it("measure() calls end() even when fn() throws", async () => {
		const name = `measure-err-${Date.now()}`
		await expect(
			startupProfiler.measure(name, async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")

		const entry = startupProfiler.summary().find((e) => e.name === name)
		expect(entry).toBeDefined()
		expect(entry!.endedAt).toBeTypeOf("number")
		expect(entry!.durationMs).toBeGreaterThanOrEqual(0)
	})
})
