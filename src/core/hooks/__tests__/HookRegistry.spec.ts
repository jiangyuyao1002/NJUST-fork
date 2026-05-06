import { describe, expect, it, vi } from "vitest"

import { HookRegistry } from "../HookRegistry"

describe("HookRegistry", () => {
	it("executes hooks by ascending priority", async () => {
		const registry = new HookRegistry()
		const order: string[] = []

		registry.register("preToolUse", "late", async () => {
			order.push("late")
		}, 200)
		registry.register("preToolUse", "early", async () => {
			order.push("early")
		}, 50)

		await registry.execute({
			hookType: "preToolUse",
			timestamp: Date.now(),
			toolName: "read_file",
			toolInput: {},
		})

		expect(order).toEqual(["early", "late"])
	})

	it("aborts pre hooks when handler returns abort", async () => {
		const registry = new HookRegistry()
		registry.register("preCompact", "guard", async () => ({ abort: true, message: "blocked" }), 10)
		const shouldNotRun = vi.fn(async () => undefined)
		registry.register("preCompact", "after", shouldNotRun, 20)

		const result = await registry.execute({
			hookType: "preCompact",
			timestamp: Date.now(),
			messageCount: 10,
			tokenCount: 2000,
		})

		expect(result.abort).toBe(true)
		expect(result.message).toBe("blocked")
		expect(shouldNotRun).not.toHaveBeenCalled()
	})

	it("continues post hooks even when abort returned", async () => {
		const registry = new HookRegistry()
		const second = vi.fn(async () => undefined)
		registry.register("postCompact", "first", async () => ({ abort: true, message: "ignored" }), 10)
		registry.register("postCompact", "second", second, 20)

		const result = await registry.execute({
			hookType: "postCompact",
			timestamp: Date.now(),
			messageCountBefore: 10,
			messageCountAfter: 5,
			tokenCountBefore: 5000,
			tokenCountAfter: 2200,
		})

		expect(result.abort).toBe(false)
		expect(second).toHaveBeenCalledOnce()
	})

	it("unregister removes hook by id", async () => {
		const registry = new HookRegistry()
		const fn = vi.fn(async () => undefined)
		const id = registry.register("preToolUse", "hook", fn, 10)
		expect(registry.unregister(id)).toBe(true)

		await registry.execute({
			hookType: "preToolUse",
			timestamp: Date.now(),
			toolName: "glob",
			toolInput: {},
		})

		expect(fn).not.toHaveBeenCalled()
	})

	it("isolates hook exceptions and continues subsequent hooks", async () => {
		const registry = new HookRegistry()
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const after = vi.fn(async () => undefined)

		registry.register("preToolUse", "throws", async () => {
			throw new Error("hook boom")
		}, 10)
		registry.register("preToolUse", "after", after, 20)

		const result = await registry.execute({
			hookType: "preToolUse",
			timestamp: Date.now(),
			toolName: "read_file",
			toolInput: {},
		})

		expect(result.abort).toBe(true)
		expect(after).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalled()
		warnSpy.mockRestore()
	})
})
