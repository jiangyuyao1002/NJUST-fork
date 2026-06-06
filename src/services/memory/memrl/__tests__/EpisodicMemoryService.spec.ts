import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import { EpisodicMemoryService } from "../EpisodicMemoryService"
import { MemoryEmbeddingAdapter } from "../MemoryEmbeddingAdapter"
import { Q_INIT, ALPHA } from "../constants"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
}))

vi.mock("../../../../shared/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function makeEmbedder(vec: number[]) {
	return {
		embed: vi.fn().mockResolvedValue(vec),
	} as unknown as MemoryEmbeddingAdapter
}

const WORKSPACE = "/fake/workspace"

describe("EpisodicMemoryService", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("load", () => {
		it("loads entries from file on first call", async () => {
			const stored = {
				entries: [{
					id: "ep_1", intent: "test intent", embedding: [0.5, 0.5],
					stmSummary: "summary", qValue: 0.5, updateCount: 1,
					createdAt: 1000, updatedAt: 1000,
				}],
				totalWrites: 1,
			}
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stored) as unknown as Buffer)
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([0.5, 0.5]))
			await svc.load()
			expect(svc.totalWrites).toBe(1)
		})

		it("starts with empty store when file does not exist", async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"))
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([]))
			await svc.load()
			expect(svc.totalWrites).toBe(0)
		})

		it("only calls readFile once cached", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([]))
			await svc.load()
			await svc.load()
			expect(fs.readFile).toHaveBeenCalledTimes(1)
		})
	})

	describe("write", () => {
		it("creates an entry with correct initial qValue", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = makeEmbedder([0.1, 0.2])
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			const reward = 1.0
			await svc.write("intent", "summary", reward)
			expect(svc.totalWrites).toBe(1)
			const entry = svc.getRecent(1)[0]!
			const expectedQ = Q_INIT + ALPHA * (reward - Q_INIT)
			expect(entry.qValue).toBeCloseTo(expectedQ)
			expect(entry.intent).toBe("intent")
		})

		it("persists to disk after write", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([0.1]))
			await svc.write("intent", "summary", 1.0)
			expect(fs.writeFile).toHaveBeenCalled()
		})

		it("calls onDistillTrigger at LTM_DISTILL_INTERVAL writes", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const trigger = vi.fn()
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([0.1]), trigger)
			for (let i = 0; i < 10; i++) {
				await svc.write("intent-" + String(i), "sum", 1.0)
			}
			expect(trigger).toHaveBeenCalledTimes(1)
		})

		it("increments totalWrites with each write", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([0.1]))
			await svc.write("i1", "s1", 1.0)
			await svc.write("i2", "s2", 0.5)
			expect(svc.totalWrites).toBe(2)
		})
	})

	describe("retrieve", () => {
		it("returns empty array when no entries", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new EpisodicMemoryService(WORKSPACE, makeEmbedder([0.1, 0.2]))
			expect(await svc.retrieve("query")).toEqual([])
		})

		it("returns empty array when embedder returns empty vector", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = { embed: vi.fn().mockResolvedValue([]) } as unknown as MemoryEmbeddingAdapter
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			await svc.write("intent", "summary", 1.0)
			expect(await svc.retrieve("query")).toEqual([])
		})

		it("filters entries below similarity threshold", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = {
				embed: vi.fn()
					.mockResolvedValueOnce([1, 0])
					.mockResolvedValueOnce([0, 1]),
			} as unknown as MemoryEmbeddingAdapter
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			await svc.write("intent", "summary", 1.0)
			expect(await svc.retrieve("query")).toEqual([])
		})

		it("returns top matching entries above threshold", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const vec = [0.6, 0.8]
			const embedder = {
				embed: vi.fn().mockResolvedValue(vec),
			} as unknown as MemoryEmbeddingAdapter
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			await svc.write("intent", "summary", 1.0)
			const results = await svc.retrieve("query")
			expect(results).toHaveLength(1)
			expect(results[0]!.intent).toBe("intent")
		})
	})

	describe("getRecent", () => {
		it("returns n most recent entries sorted by createdAt descending", async () => {
			vi.useFakeTimers()
			vi.setSystemTime(1_000_000)
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = { embed: vi.fn().mockResolvedValue([0.5, 0.5]) } as unknown as MemoryEmbeddingAdapter
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			await svc.write("first", "s1", 1.0)
			vi.setSystemTime(2_000_000)
			await svc.write("second", "s2", 1.0)
			vi.useRealTimers()
			const recent = svc.getRecent(1)
			expect(recent).toHaveLength(1)
			expect(recent[0]!.intent).toBe("second")
		})

		it("returns all entries if n > total", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = { embed: vi.fn().mockResolvedValue([0.5]) } as unknown as MemoryEmbeddingAdapter
			const svc = new EpisodicMemoryService(WORKSPACE, embedder)
			await svc.write("a", "s", 1.0)
			expect(svc.getRecent(100)).toHaveLength(1)
		})
	})
})
