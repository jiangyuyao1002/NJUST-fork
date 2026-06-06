import { describe, expect, it, vi } from "vitest"
import { MemoryEmbeddingAdapter } from "../MemoryEmbeddingAdapter"
import type { IEmbedder } from "../../../code-index/interfaces/embedder"

function makeEmbedder(embeddings: number[][]): IEmbedder {
	return {
		createEmbeddings: vi.fn().mockResolvedValue({ embeddings }),
		validateConfiguration: vi.fn().mockResolvedValue({ valid: true }),
		get embedderInfo() {
			return { name: "openai" as const }
		},
	}
}

describe("MemoryEmbeddingAdapter", () => {
	describe("embed", () => {
		it("returns first embedding from createEmbeddings", async () => {
			const vec = [0.1, 0.2, 0.3]
			const adapter = new MemoryEmbeddingAdapter(makeEmbedder([vec]))
			const result = await adapter.embed("hello")
			expect(result).toEqual(vec)
		})

		it("returns empty array on embedder error", async () => {
			const err: IEmbedder = {
				createEmbeddings: vi.fn().mockRejectedValue(new Error("fail")),
				validateConfiguration: vi.fn().mockResolvedValue({ valid: false, error: "fail" }),
				get embedderInfo() {
					return { name: "openai" as const }
				},
			}
			const adapter = new MemoryEmbeddingAdapter(err)
			expect(await adapter.embed("x")).toEqual([])
		})

		it("returns empty array when embeddings result is empty", async () => {
			const adapter = new MemoryEmbeddingAdapter(makeEmbedder([]))
			expect(await adapter.embed("x")).toEqual([])
		})
	})

	describe("embedBatch", () => {
		it("returns all embeddings", async () => {
			const vecs = [[0.1, 0.2], [0.3, 0.4]]
			const adapter = new MemoryEmbeddingAdapter(makeEmbedder(vecs))
			expect(await adapter.embedBatch(["a", "b"])).toEqual(vecs)
		})

		it("returns empty array for empty input", async () => {
			const adapter = new MemoryEmbeddingAdapter(makeEmbedder([]))
			expect(await adapter.embedBatch([])).toEqual([])
		})

		it("returns array of empty arrays on error", async () => {
			const err: IEmbedder = {
				createEmbeddings: vi.fn().mockRejectedValue(new Error("fail")),
				validateConfiguration: vi.fn().mockResolvedValue({ valid: false }),
				get embedderInfo() {
					return { name: "openai" as const }
				},
			}
			const adapter = new MemoryEmbeddingAdapter(err)
			const result = await adapter.embedBatch(["a", "b"])
			expect(result).toEqual([[], []])
		})
	})

	describe("cosineSim (static)", () => {
		it("returns 1.0 for identical unit vectors", () => {
			const v = [1, 0, 0]
			expect(MemoryEmbeddingAdapter.cosineSim(v, v)).toBeCloseTo(1.0)
		})

		it("returns 0.0 for orthogonal vectors", () => {
			expect(MemoryEmbeddingAdapter.cosineSim([1, 0], [0, 1])).toBeCloseTo(0.0)
		})

		it("returns -1.0 for opposite vectors", () => {
			expect(MemoryEmbeddingAdapter.cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1.0)
		})

		it("returns 0 for zero vectors", () => {
			expect(MemoryEmbeddingAdapter.cosineSim([0, 0], [1, 1])).toBe(0)
			expect(MemoryEmbeddingAdapter.cosineSim([], [])).toBe(0)
		})

		it("returns 0 for mismatched lengths", () => {
			expect(MemoryEmbeddingAdapter.cosineSim([1, 2], [1])).toBe(0)
		})

		it("handles non-unit vectors correctly", () => {
			const sim = MemoryEmbeddingAdapter.cosineSim([3, 4], [3, 4])
			expect(sim).toBeCloseTo(1.0)
		})
	})

	describe("zScore (static)", () => {
		it("returns empty array for empty input", () => {
			expect(MemoryEmbeddingAdapter.zScore([])).toEqual([])
		})

		it("returns zeros when all values are equal (std = 0)", () => {
			expect(MemoryEmbeddingAdapter.zScore([5, 5, 5])).toEqual([0, 0, 0])
		})

		it("normalizes values to zero mean and unit variance", () => {
			const scores = MemoryEmbeddingAdapter.zScore([1, 2, 3])
			const mean = scores.reduce((s, v) => s + v, 0) / scores.length
			expect(mean).toBeCloseTo(0, 5)
		})

		it("correctly identifies highest-valued element", () => {
			const scores = MemoryEmbeddingAdapter.zScore([1, 2, 10])
			const maxIdx = scores.indexOf(Math.max(...scores))
			expect(maxIdx).toBe(2)
		})
	})
})
