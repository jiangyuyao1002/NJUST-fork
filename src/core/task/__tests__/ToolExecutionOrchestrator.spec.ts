import { describe, expect, it } from "vitest"

import {
	ToolExecutionScheduler,
	ToolExecutionStats,
	classifyToolCategory,
	prioritizeTools,
} from "../ToolExecutionOrchestrator"

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("classifyToolCategory", () => {
	it("treats checkpointed tools as writes", () => {
		expect(classifyToolCategory("read_file", true)).toBe("write")
	})

	it("classifies mcp tools by prefix or name", () => {
		expect(classifyToolCategory("mcp_read_file", false)).toBe("mcp")
		expect(classifyToolCategory("use_mcp_tool", false)).toBe("mcp")
	})

	it("classifies shell tools as bash", () => {
		expect(classifyToolCategory("execute_command", false)).toBe("bash")
		expect(classifyToolCategory("bash", false)).toBe("bash")
		expect(classifyToolCategory("command", false)).toBe("bash")
	})

	it("classifies explicit write tools case-insensitively", () => {
		expect(classifyToolCategory("WRITE_TO_FILE", false)).toBe("write")
		expect(classifyToolCategory("apply_diff", false)).toBe("write")
		expect(classifyToolCategory("new_task", false)).toBe("write")
	})

	it("defaults unknown tools to read", () => {
		expect(classifyToolCategory("read_file", false)).toBe("read")
		expect(classifyToolCategory("unknown_tool", false)).toBe("read")
	})
})

describe("prioritizeTools", () => {
	it("sorts read, mcp, bash, then write tools", () => {
		const result = prioritizeTools([
			{ name: "write_to_file", requiresCheckpoint: false },
			{ name: "execute_command", requiresCheckpoint: false },
			{ name: "use_mcp_tool", requiresCheckpoint: false },
			{ name: "read_file", requiresCheckpoint: false },
		])

		expect(result.map((item) => item.toolName)).toEqual([
			"read_file",
			"use_mcp_tool",
			"execute_command",
			"write_to_file",
		])
		expect(result.map((item) => item.category)).toEqual(["read", "mcp", "bash", "write"])
	})

	it("records original indexes after sorting", () => {
		const result = prioritizeTools([
			{ name: "apply_diff", requiresCheckpoint: false },
			{ name: "read_file", requiresCheckpoint: false },
		])

		expect(result).toMatchObject([
			{ toolName: "read_file", index: 1, priority: 0 },
			{ toolName: "apply_diff", index: 0, priority: 3 },
		])
	})

	it("treats checkpointed read tools as write priority", () => {
		const result = prioritizeTools([{ name: "read_file", requiresCheckpoint: true }])

		expect(result[0]).toMatchObject({
			toolName: "read_file",
			category: "write",
			priority: 3,
		})
	})
})

describe("ToolExecutionScheduler", () => {
	it("allows concurrent readers", async () => {
		const scheduler = new ToolExecutionScheduler()

		await scheduler.acquire("read")
		await scheduler.acquire("mcp")
		await scheduler.acquire("bash")

		expect(scheduler.getStatus()).toEqual({
			writeLocked: false,
			activeReaders: 3,
			waitingCount: 0,
		})
	})

	it("makes writers wait for active readers", async () => {
		const scheduler = new ToolExecutionScheduler()
		await scheduler.acquire("read")

		let acquired = false
		const pending = scheduler.acquire("write").then(() => {
			acquired = true
		})
		await flushMicrotasks()

		expect(acquired).toBe(false)
		expect(scheduler.getStatus()).toMatchObject({ activeReaders: 1, waitingCount: 1 })

		scheduler.release("read")
		await pending

		expect(acquired).toBe(true)
		expect(scheduler.getStatus()).toMatchObject({ writeLocked: true, activeReaders: 0 })
	})

	it("makes readers wait for active writer", async () => {
		const scheduler = new ToolExecutionScheduler()
		await scheduler.acquire("write")

		let acquired = false
		const pending = scheduler.acquire("read").then(() => {
			acquired = true
		})
		await flushMicrotasks()

		expect(acquired).toBe(false)
		expect(scheduler.getStatus()).toMatchObject({ writeLocked: true, waitingCount: 1 })

		scheduler.release("write")
		await pending

		expect(acquired).toBe(true)
		expect(scheduler.getStatus()).toMatchObject({ writeLocked: false, activeReaders: 1 })
	})

	it("does not let activeReaders go below zero", () => {
		const scheduler = new ToolExecutionScheduler()

		scheduler.release("read")

		expect(scheduler.getStatus().activeReaders).toBe(0)
	})
})

describe("ToolExecutionStats", () => {
	it("returns zeroes for unknown tools", () => {
		const stats = new ToolExecutionStats()

		expect(stats.getAverageDuration("read_file")).toBe(0)
		expect(stats.getFailureRate("read_file")).toBe(0)
	})

	it("tracks average duration and failure rate", () => {
		const stats = new ToolExecutionStats()

		stats.record("read_file", 100)
		stats.record("read_file", 300, true)
		stats.record("write_to_file", 50)

		expect(stats.getAverageDuration("read_file")).toBe(200)
		expect(stats.getFailureRate("read_file")).toBe(0.5)
		expect(stats.getAverageDuration("write_to_file")).toBe(50)
	})

	it("returns summarized stats for every tool", () => {
		const stats = new ToolExecutionStats()
		stats.record("read_file", 100)
		stats.record("read_file", 200, true)

		expect(stats.getAll().get("read_file")).toEqual({
			count: 2,
			avgMs: 150,
			failureRate: 0.5,
		})
	})

	it("clears all stats on reset", () => {
		const stats = new ToolExecutionStats()
		stats.record("read_file", 100, true)

		stats.reset()

		expect(stats.getAll().size).toBe(0)
		expect(stats.getAverageDuration("read_file")).toBe(0)
	})
})
