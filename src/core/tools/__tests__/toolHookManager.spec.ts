import { describe, expect, it, vi } from "vitest"

import { ToolHookManager } from "../ToolHookManager"

describe("ToolHookManager", () => {
	it("short-circuits pre-hooks when a hook denies execution", async () => {
		const mgr = new ToolHookManager()
		mgr.registerPreHook(async () => ({ allow: true, modifiedInput: { path: "a.ts" } }))
		mgr.registerPreHook(async () => ({ allow: false, reason: "blocked by policy" }))

		const result = await mgr.runPreHooks("read_file", { path: "x.ts" }, { taskId: "t1" } as any)
		expect(result.allow).toBe(false)
		expect(result.reason).toBe("blocked by policy")
	})

	it("propagates modified input across pre-hooks", async () => {
		const mgr = new ToolHookManager()
		mgr.registerPreHook(async (_tool, input) => ({ allow: true, modifiedInput: { ...input, a: 1 } }))
		mgr.registerPreHook(async (_tool, input) => ({ allow: true, modifiedInput: { ...input, b: 2 } }))

		const result = await mgr.runPreHooks("search_files", { q: "x" }, { taskId: "t2" } as any)
		expect(result.allow).toBe(true)
		expect(result.modifiedInput).toEqual({ q: "x", a: 1, b: 2 })
	})

	it("runs post-hooks and failure-hooks without throwing on hook errors", async () => {
		const mgr = new ToolHookManager()
		const postSpy = vi.fn(async () => undefined)
		const failureSpy = vi.fn(async () => undefined)
		mgr.registerPostHook(async () => {
			throw new Error("post hook failure")
		})
		mgr.registerPostHook(postSpy)
		mgr.registerFailureHook(async () => {
			throw new Error("failure hook failure")
		})
		mgr.registerFailureHook(failureSpy)

		await expect(
			mgr.runPostHooks("tool_search", { q: "abc" }, "ok" as any, { taskId: "t3" } as any),
		).resolves.toBeUndefined()
		await expect(
			mgr.runFailureHooks("tool_search", { q: "abc" }, new Error("tool error"), { taskId: "t3" } as any),
		).resolves.toBeUndefined()

		expect(postSpy).toHaveBeenCalledTimes(1)
		expect(failureSpy).toHaveBeenCalledTimes(1)
	})

	it("short-circuits pre-compact hooks when a hook denies compaction", async () => {
		const mgr = new ToolHookManager()
		const after = vi.fn(async function () {
			return {
				allow: true,
			}
		})

		mgr.registerPreCompactHook(async () => ({ allow: false, reason: "cache hot" }))
		mgr.registerPreCompactHook(after)

		const result = await mgr.runPreCompactHooks({
			taskId: "task-1",
			messageCount: 10,
			tokenCount: 2000,
		})

		expect(result.allow).toBe(false)
		expect(result.reason).toBe("cache hot")
		expect(after).not.toHaveBeenCalled()
	})

	it("runs post-compact hooks even when one hook throws", async () => {
		const mgr = new ToolHookManager()
		const after = vi.fn(async () => undefined)

		mgr.registerPostCompactHook(async () => {
			throw new Error("post compact failed")
		})
		mgr.registerPostCompactHook(after)

		await expect(
			mgr.runPostCompactHooks({
				taskId: "task-1",
				messageCountBefore: 10,
				messageCountAfter: 4,
				tokenCountBefore: 2000,
				tokenCountAfter: 900,
			}),
		).resolves.toBeUndefined()

		expect(after).toHaveBeenCalledOnce()
	})
})
