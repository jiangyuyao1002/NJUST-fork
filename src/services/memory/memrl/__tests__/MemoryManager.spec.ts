import { describe, expect, it, vi, beforeEach } from "vitest"
import { MemoryManager } from "../MemoryManager"
import type { ApiHandler } from "../../../../api"
import type { IEmbedder } from "../../../code-index/interfaces/embedder"
import { ShortTermMemory } from "../ShortTermMemory"

vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../../shared/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeApi(): ApiHandler {
	async function* stream() {
		yield { type: "text" as const, text: "[]" }
	}
	return { createMessage: vi.fn().mockReturnValue(stream()) } as unknown as ApiHandler
}

function makeEmbedder(vec: number[] = [0.5, 0.5]): IEmbedder {
	return {
		createEmbeddings: vi.fn().mockResolvedValue({ embeddings: [vec] }),
		validateConfiguration: vi.fn().mockResolvedValue({ valid: true }),
		get embedderInfo() {
			return { name: "openai" as const }
		},
	}
}

const WORKSPACE = "/fake/ws"

describe("MemoryManager", () => {
	let manager: MemoryManager

	beforeEach(() => {
		vi.clearAllMocks()
		manager = new MemoryManager(WORKSPACE)
	})

	describe("constructor", () => {
		it("stores workspaceDir", () => {
			expect(manager.workspaceDir).toBe(WORKSPACE)
		})
	})

	describe("updateDependencies", () => {
		it("initialises without error when no embedder provided", () => {
			expect(() => manager.updateDependencies(makeApi())).not.toThrow()
		})

		it("initialises without error with embedder provided", () => {
			expect(() => manager.updateDependencies(makeApi(), makeEmbedder())).not.toThrow()
		})
	})

	describe("beforeRun", () => {
		it("returns empty strings when no dependencies set", async () => {
			const result = await manager.beforeRun("task-1", "do something")
			expect(result.episodicHints).toBe("")
			expect(result.ltmRules).toBe("")
		})

		it("clears STM for the given taskId", async () => {
			manager.updateDependencies(makeApi(), makeEmbedder())
			const stm = manager.getStm("task-1")
			stm.push("user", "existing content")
			await manager.beforeRun("task-1", "intent")
			expect(manager.getStm("task-1").getEntries()).toHaveLength(0)
		})

		it("returns empty hints when no matching episodes/rules", async () => {
			manager.updateDependencies(makeApi(), makeEmbedder([0.1, 0.2]))
			const result = await manager.beforeRun("task-new", "fresh intent")
			expect(result.episodicHints).toBe("")
			expect(result.ltmRules).toBe("")
		})
	})

	describe("afterRun", () => {
		it("does not throw when no dependencies set", () => {
			expect(() => manager.afterRun("task-1", "intent", "summary", 1.0)).not.toThrow()
		})

		it("deletes STM for the task after write completes", async () => {
			manager.updateDependencies(makeApi(), makeEmbedder())
			const stm = manager.getStm("task-1")
			stm.push("user", "content")

			// afterRun is fire-and-forget; flush microtask queue via setImmediate
			// (fires after all pending microtasks, no real-time dependency)
			manager.afterRun("task-1", "intent", "summary", 1.0)
			await new Promise<void>((r) => setImmediate(r))
			// STM should have been deleted
			const newStm = manager.getStm("task-1")
			expect(newStm.getEntries()).toHaveLength(0)
		})
	})

	describe("getStm", () => {
		it("returns a ShortTermMemory instance", () => {
			const stm = manager.getStm("task-42")
			expect(stm).toBeInstanceOf(ShortTermMemory)
		})

		it("returns the same instance for the same taskId", () => {
			const a = manager.getStm("task-x")
			const b = manager.getStm("task-x")
			expect(a).toBe(b)
		})

		it("returns different instances for different taskIds", () => {
			const a = manager.getStm("task-a")
			const b = manager.getStm("task-b")
			expect(a).not.toBe(b)
		})
	})
})
