import { describe, expect, it } from "vitest"

import { ConcurrentToolExecutor } from "../ConcurrentToolExecutor"
import { ToolDependencyGraph } from "../ToolDependencyGraph"

describe("ConcurrentToolExecutor", () => {
	it("runs all tasks", async () => {
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 3 })
		const input = [1, 2, 3, 4, 5]
		const out: number[] = []
		await ex.run(input, async (x) => {
			out.push(x)
		})
		expect(out.sort((a, b) => a - b)).toEqual(input)
	})

	it("aborts siblings in fail-fast mode", async () => {
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 3 })
		const input = [1, 2, 3, 4, 5, 6]
		let observedAbortSignal = false

		await expect(
			ex.run(
				input,
				async (x, _idx, ctx) => {
					if (x === 2) {
						throw new Error("boom")
					}

					await Promise.race([
						new Promise<void>((resolve) => setTimeout(resolve, 5)),
						new Promise<void>((resolve) => {
							if (ctx.signal.aborted) {
								observedAbortSignal = true
								resolve()
								return
							}
							ctx.signal.addEventListener(
								"abort",
								() => {
									observedAbortSignal = true
									resolve()
								},
								{ once: true },
							)
						}),
					])
				},
				{ failFast: true },
			),
		).rejects.toThrow("ConcurrentToolExecutor")

		expect(observedAbortSignal).toBe(true)
	})

	it("clamps invalid maxConcurrency to one worker", async () => {
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 0 })
		const order: number[] = []

		await ex.run([1, 2, 3], async (item) => {
			order.push(item)
		})

		expect(order).toEqual([1, 2, 3])
	})

	it("uses adaptive concurrency controller and scheduler in lock order", async () => {
		const calls: string[] = []
		const controller = {
			getEffectiveMaxConcurrency: () => 1,
			acquire: async (category: string) => {
				calls.push(`controller.acquire:${category}`)
			},
			release: (category: string) => {
				calls.push(`controller.release:${category}`)
			},
		} as any
		const scheduler = {
			acquire: async (category: string) => {
				calls.push(`scheduler.acquire:${category}`)
			},
			release: (category: string) => {
				calls.push(`scheduler.release:${category}`)
			},
		} as any
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 3, concurrencyController: controller, scheduler })

		await ex.run([1], async () => calls.push("run"), {
			itemCategories: new Map([[0, "read" as any]]),
		})

		expect(calls).toEqual([
			"scheduler.acquire:read",
			"scheduler.release:read",
			"controller.acquire:read",
			"scheduler.acquire:read",
			"run",
			"scheduler.release:read",
			"controller.release:read",
		])
	})

	it("continues running items in continueOnError mode and reports all failures", async () => {
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 2 })
		const seen: number[] = []

		await expect(
			ex.run(
				[1, 2, 3],
				async (item) => {
					seen.push(item)
					if (item !== 2) throw new Error(`fail ${item}`)
				},
				{ abortStrategy: "continueOnError" },
			),
		).rejects.toThrow("continueOnError")

		expect(seen.sort()).toEqual([1, 2, 3])
	})

	it("skips transitive dependents when dependency fails", async () => {
		const graph = new ToolDependencyGraph()
		graph.addDependency("deploy", "build")
		graph.addDependency("notify", "deploy")
		const ex = new ConcurrentToolExecutor({ maxConcurrency: 1 })
		const seen: number[] = []

		await expect(
			ex.run(
				["build", "deploy", "notify"],
				async (tool, index) => {
					seen.push(index)
					if (tool === "build") throw new Error("build failed")
				},
				{
					abortStrategy: "transitiveAbort",
					dependencyGraph: graph,
					itemToolNames: new Map([
						[0, "build"],
						[1, "deploy"],
						[2, "notify"],
					]),
				},
			),
		).rejects.toThrow("Skipped: dependency failed")

		expect(seen).toEqual([0])
	})
})
