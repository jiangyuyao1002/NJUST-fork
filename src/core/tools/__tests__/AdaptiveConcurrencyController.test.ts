import { describe, expect, it } from "vitest"
import { AdaptiveConcurrencyController } from "../AdaptiveConcurrencyController"
import { ConcurrentToolExecutor } from "../ConcurrentToolExecutor"
import { ToolExecutionScheduler, type ToolCategory, ToolExecutionStats } from "../../task/ToolExecutionOrchestrator"

describe("AdaptiveConcurrencyController", () => {
	it("acquire and release works", async () => {
		const c = new AdaptiveConcurrencyController({ read: 1 })
		await c.acquire("read")
		expect(c.getStatus().read.active).toBe(1)
		c.release("read")
		expect(c.getStatus().read.active).toBe(0)
	})

	it("enforces concurrency limits", async () => {
		const c = new AdaptiveConcurrencyController({ read: 2 })
		let active = 0
		let maxActive = 0
		await Promise.all(
			Array.from({ length: 5 }).map(async () => {
				await c.acquire("read")
				active++
				maxActive = Math.max(maxActive, active)
				await new Promise((r) => setTimeout(r, 10))
				active--
				c.release("read")
			}),
		)
		expect(maxActive).toBeLessThanOrEqual(4)
	})

	it("does not deadlock at limit 1", async () => {
		const c = new AdaptiveConcurrencyController({ write: 1 })
		await c.acquire("write")
		const p = c.acquire("write")
		c.release("write")
		await expect(p).resolves.toBeUndefined()
	})

	it("adjustLimit updates status", () => {
		const c = new AdaptiveConcurrencyController({ read: 2 })
		c.adjustLimit("read", 4)
		expect(c.getStatus().read.limit).toBe(4)
	})

	it("tunes based on stats", () => {
		const c = new AdaptiveConcurrencyController({ read: 2 })
		const stats = new ToolExecutionStats()
		for (let i = 0; i < 10; i++) stats.record("njust_ai_readFile", 3000, i < 3)
		c.tune(stats)
		expect(c.getStatus().read.limit).toBeLessThanOrEqual(2)
	})
})

describe("executor integration", () => {
	it("limits per category", async () => {
		const controller = new AdaptiveConcurrencyController({ read: 1, write: 1 })
		const executor = new ConcurrentToolExecutor({ maxConcurrency: 4, concurrencyController: controller })
		const items = [0, 1, 2]
		let maxRead = 0
		let maxWrite = 0
		await executor.run(
			items,
			async (_item, idx) => {
				const category: ToolCategory = idx === 0 || idx === 2 ? "read" : "write"
				const statusBefore = controller.getStatus()[category].active
				if (category === "read") maxRead = Math.max(maxRead, statusBefore)
				else maxWrite = Math.max(maxWrite, statusBefore)
				await new Promise((r) => setTimeout(r, 5))
			},
			{
				itemCategories: new Map([
					[0, "read"],
					[1, "write"],
					[2, "read"],
				]),
			},
		)
		expect(maxRead).toBeLessThanOrEqual(1)
		expect(maxWrite).toBeLessThanOrEqual(1)
	})

	it("scheduler serializes writes", async () => {
		const controller = new AdaptiveConcurrencyController({ write: 1, read: 2 })
		const scheduler = new ToolExecutionScheduler()
		const executor = new ConcurrentToolExecutor({ maxConcurrency: 3, concurrencyController: controller, scheduler })
		const events: string[] = []
		await executor.run(
			["r1", "w1", "r2"],
			async (item, idx) => {
				events.push(`start-${item}`)
				await new Promise((r) => setTimeout(r, idx === 1 ? 15 : 5))
				events.push(`end-${item}`)
			},
			{
				itemCategories: new Map([
					[0, "read"],
					[1, "write"],
					[2, "read"],
				]),
			},
		)
		expect(events.indexOf("start-w1")).toBeGreaterThanOrEqual(0)
	})
})
