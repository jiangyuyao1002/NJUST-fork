import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import { LongTermMemoryService } from "../LongTermMemoryService"
import { MemoryEmbeddingAdapter } from "../MemoryEmbeddingAdapter"
import type { ApiHandler } from "../../../../api"
import type { EpisodicEntry } from "../EpisodicMemoryService"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
}))

/** Each call returns a fresh async generator for the given response. */
function makeApi(jsonResponse: string): ApiHandler {
	return {
		createMessage: vi.fn().mockImplementation(() =>
			(async function* () {
				yield { type: "text" as const, text: jsonResponse }
			})(),
		),
	} as unknown as ApiHandler
}

/** Returns an api whose successive calls return different responses. */
function makeMultiApi(responses: string[]): ApiHandler {
	let idx = 0
	return {
		createMessage: vi.fn().mockImplementation(() => {
			const resp = responses[idx++] ?? "[]"
			return (async function* () {
				yield { type: "text" as const, text: resp }
			})()
		}),
	} as unknown as ApiHandler
}

function makeEmbedder(vec: number[]) {
	return {
		embed: vi.fn().mockResolvedValue(vec),
	} as unknown as MemoryEmbeddingAdapter
}

function makeEpisodicEntry(overrides: Partial<EpisodicEntry> = {}): EpisodicEntry {
	return {
		id: "ep_1",
		intent: "fix the bug",
		embedding: [0.5, 0.5],
		stmSummary: "applied patch",
		qValue: 0.55,
		updateCount: 1,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	}
}

const WORKSPACE = "/fake/workspace"

describe("LongTermMemoryService", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("load", () => {
		it("loads rules from file", async () => {
			const stored = {
				rules: [{
					id: "ltm_1", topic: "TypeScript", rule: "always use strict mode",
					examples: [], confidence: 0.9, useCount: 0,
					createdAt: 1000, updatedAt: 1000, embedding: [0.5, 0.5],
				}],
			}
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(stored) as unknown as Buffer)
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5, 0.5]), makeApi("[]"))
			await svc.load()
			expect(svc.getRules()).toHaveLength(1)
		})

		it("starts with empty rules when file not found", async () => {
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([]), makeApi("[]"))
			await svc.load()
			expect(svc.getRules()).toHaveLength(0)
		})

		it("only calls readFile once (cached after first load)", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([]), makeApi("[]"))
			await svc.load()
			await svc.load()
			expect(fs.readFile).toHaveBeenCalledTimes(1)
		})
	})

	describe("distill", () => {
		it("does nothing when given empty episodes", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const api = makeApi("[]")
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5, 0.5]), api)
			await svc.distill([])
			expect(api.createMessage).not.toHaveBeenCalled()
		})

		it("adds new rules extracted from episodes", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const rules = [{ topic: "Testing", rule: "write small focused tests", examples: ["example"], confidence: 0.8 }]
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.1, 0.2]), makeApi(JSON.stringify(rules)))
			await svc.distill([makeEpisodicEntry()])
			expect(svc.getRules()).toHaveLength(1)
			expect(svc.getRules()[0]!.topic).toBe("Testing")
		})

		it("merges duplicate rules when embedding similarity >= 0.85", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			// Two calls: first adds rule with confidence 0.7, second updates to 0.9
			const api = makeMultiApi([
				JSON.stringify([{ topic: "DRY", rule: "dont repeat yourself", examples: [], confidence: 0.7 }]),
				JSON.stringify([{ topic: "DRY", rule: "dont repeat yourself", examples: [], confidence: 0.9 }]),
			])
			// Same embedding for every call so cosineSim = 1.0 >= 0.85
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.6, 0.8]), api)
			await svc.distill([makeEpisodicEntry()])
			expect(svc.getRules()).toHaveLength(1)
			// Second distill: same rule with higher confidence should merge, not add
			await svc.distill([makeEpisodicEntry()])
			expect(svc.getRules()).toHaveLength(1)
			expect(svc.getRules()[0]!.confidence).toBeCloseTo(0.9)
		})

		it("skips rules without topic or rule fields", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const badJson = JSON.stringify([{ topic: "", rule: "missing topic" }, { topic: "ok", rule: "" }])
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5]), makeApi(badJson))
			await svc.distill([makeEpisodicEntry()])
			expect(svc.getRules()).toHaveLength(0)
		})

		it("gracefully handles malformed JSON from API", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5]), makeApi("not json at all"))
			await expect(svc.distill([makeEpisodicEntry()])).resolves.not.toThrow()
		})

		it("clamps confidence to [0, 1]", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const rules = [{ topic: "T", rule: "r", examples: [], confidence: 5.0 }]
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5, 0.5]), makeApi(JSON.stringify(rules)))
			await svc.distill([makeEpisodicEntry()])
			expect(svc.getRules()[0]!.confidence).toBeLessThanOrEqual(1)
		})
	})

	describe("retrieve", () => {
		it("returns empty when no rules exist", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5]), makeApi("[]"))
			expect(await svc.retrieve("query")).toEqual([])
		})

		it("returns empty when embedder returns empty vector", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const embedder = { embed: vi.fn().mockResolvedValue([]) } as unknown as MemoryEmbeddingAdapter
			const svc = new LongTermMemoryService(WORKSPACE, embedder, makeApi("[]"))
			await svc.load()
			expect(await svc.retrieve("q")).toEqual([])
		})
	})

	describe("markUsed", () => {
		it("increments useCount for matching rule ids", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const rules = [{ topic: "T", rule: "r", examples: [], confidence: 0.8 }]
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5, 0.5]), makeApi(JSON.stringify(rules)))
			await svc.distill([makeEpisodicEntry()])
			const id = svc.getRules()[0]!.id
			await svc.markUsed([id])
			expect(svc.getRules()[0]!.useCount).toBe(1)
		})

		it("does not persist when no ids match", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([0.5]), makeApi("[]"))
			await svc.load()
			const callsBefore = vi.mocked(fs.writeFile).mock.calls.length
			await svc.markUsed(["non-existent-id"])
			expect(vi.mocked(fs.writeFile).mock.calls.length).toBe(callsBefore)
		})
	})

	describe("getRules", () => {
		it("returns readonly snapshot", async () => {
			vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
			const svc = new LongTermMemoryService(WORKSPACE, makeEmbedder([]), makeApi("[]"))
			await svc.load()
			expect(svc.getRules()).toHaveLength(0)
		})
	})
})
