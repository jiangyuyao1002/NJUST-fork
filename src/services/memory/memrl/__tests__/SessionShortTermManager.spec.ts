import { describe, expect, it } from "vitest"
import { SessionShortTermManager } from "../SessionShortTermManager"
import { ShortTermMemory } from "../ShortTermMemory"

describe("SessionShortTermManager", () => {
	describe("get", () => {
		it("creates a new ShortTermMemory for an unknown taskId", () => {
			const mgr = new SessionShortTermManager()
			const stm = mgr.get("task-1")
			expect(stm).toBeInstanceOf(ShortTermMemory)
		})

		it("returns the same instance on repeated access", () => {
			const mgr = new SessionShortTermManager()
			const a = mgr.get("task-1")
			a.push("user", "hello")
			const b = mgr.get("task-1")
			expect(b.getEntries()).toHaveLength(1)
		})

		it("maintains LRU order: evicts least-recently-used when full", () => {
			const mgr = new SessionShortTermManager(3)
			mgr.get("t1").push("user", "t1")
			mgr.get("t2").push("user", "t2")
			mgr.get("t3").push("user", "t3")
			expect(mgr.size).toBe(3)

			// Access t4 — t1 should be evicted (LRU)
			mgr.get("t4")
			expect(mgr.size).toBe(3)
			// t1 is gone; t2, t3, t4 remain
			const t2 = mgr.get("t2")
			expect(t2.getEntries()).toHaveLength(1)
		})

		it("re-accessing an entry promotes it above eviction", () => {
			const mgr = new SessionShortTermManager(3)
			mgr.get("t1").push("user", "data")
			mgr.get("t2")
			mgr.get("t3")
			// Re-access t1 → it becomes MRU; t2 becomes LRU
			mgr.get("t1")
			// Insert t4 → t2 should be evicted, not t1
			mgr.get("t4")
			expect(mgr.size).toBe(3)
			// t1 should still have its entry
			expect(mgr.get("t1").getEntries()).toHaveLength(1)
		})
	})

	describe("delete", () => {
		it("removes the entry for a given taskId", () => {
			const mgr = new SessionShortTermManager()
			mgr.get("task-x")
			expect(mgr.size).toBe(1)
			mgr.delete("task-x")
			expect(mgr.size).toBe(0)
		})

		it("is a no-op for unknown taskId", () => {
			const mgr = new SessionShortTermManager()
			expect(() => mgr.delete("unknown")).not.toThrow()
		})
	})

	describe("size", () => {
		it("returns 0 when empty", () => {
			expect(new SessionShortTermManager().size).toBe(0)
		})

		it("reflects the number of tracked tasks", () => {
			const mgr = new SessionShortTermManager()
			mgr.get("t1")
			mgr.get("t2")
			expect(mgr.size).toBe(2)
		})
	})
})
