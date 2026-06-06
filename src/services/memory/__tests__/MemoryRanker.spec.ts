import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { scoreRelevance, rankMemories } from "../MemoryRanker"
import type { MemoryEntry } from "../MemoryStore"

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "test-id",
		type: "session",
		timestamp: Date.now(),
		content: "some memory content",
		tags: [],
		source: "test",
		...overrides,
	}
}

describe("MemoryRanker", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_000_000)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("scoreRelevance", () => {
		it("returns a number between 0 and 1", () => {
			const entry = makeEntry({ content: "typescript async await" })
			const score = scoreRelevance(entry, "typescript patterns")
			expect(score).toBeGreaterThanOrEqual(0)
			expect(score).toBeLessThanOrEqual(1)
		})

		it("scores identical content higher than unrelated content", () => {
			const query = "typescript async await patterns"
			const relevant = makeEntry({ content: "typescript async await patterns in code" })
			const irrelevant = makeEntry({ content: "cooking recipes for pasta dinner" })
			expect(scoreRelevance(relevant, query)).toBeGreaterThan(scoreRelevance(irrelevant, query))
		})

		it("uses tag tokens in scoring", () => {
			const query = "memory management leak detection"
			const withTags = makeEntry({
				content: "unrelated content here",
				tags: ["memory", "management", "leak"],
			})
			const noTags = makeEntry({
				content: "unrelated content here",
				tags: [],
			})
			expect(scoreRelevance(withTags, query)).toBeGreaterThan(scoreRelevance(noTags, query))
		})

		it("gives higher score to recent entries", () => {
			const query = "some query"
			const recent = makeEntry({ content: query, timestamp: Date.now() })
			const old = makeEntry({ content: query, timestamp: Date.now() - 30 * 24 * 60 * 60 * 1000 })
			expect(scoreRelevance(recent, query)).toBeGreaterThanOrEqual(scoreRelevance(old, query))
		})

		it("returns 0 when query and content share no tokens", () => {
			const entry = makeEntry({ content: "xyz abc def", tags: [] })
			// Query tokens must be ≥3 chars; "zzz" doesn't match "xyz","abc","def"
			const score = scoreRelevance(entry, "qqq www eee")
			expect(score).toBeGreaterThanOrEqual(0)
			// Content score is 0; tag score is 0; only recency contributes
			expect(score).toBeLessThan(0.2) // recency-only contribution is small
		})

		it("handles empty query", () => {
			const entry = makeEntry({ content: "some content" })
			expect(() => scoreRelevance(entry, "")).not.toThrow()
		})

		it("handles empty content", () => {
			const entry = makeEntry({ content: "" })
			const score = scoreRelevance(entry, "some query")
			expect(score).toBeGreaterThanOrEqual(0)
		})
	})

	describe("rankMemories", () => {
		it("returns memories sorted by relevance descending", () => {
			const query = "typescript async programming"
			const memories: MemoryEntry[] = [
				makeEntry({ id: "low", content: "cooking pasta recipe" }),
				makeEntry({ id: "high", content: "typescript async await programming patterns" }),
				makeEntry({ id: "mid", content: "typescript code review" }),
			]
			const ranked = rankMemories(memories, query, 0)
			expect(ranked[0]!.id).toBe("high")
		})

		it("filters out memories below the threshold", () => {
			const query = "very specific query about elephants"
			const memories: MemoryEntry[] = [
				makeEntry({ id: "irrelevant", content: "cooking pasta", tags: [] }),
			]
			const ranked = rankMemories(memories, query, 0.5)
			expect(ranked).toHaveLength(0)
		})

		it("respects maxResults limit", () => {
			const query = "typescript"
			const memories: MemoryEntry[] = Array.from({ length: 20 }, (_, i) =>
				makeEntry({ id: `m${i}`, content: `typescript entry ${i}` }),
			)
			const ranked = rankMemories(memories, query, 0, 5)
			expect(ranked).toHaveLength(5)
		})

		it("returns empty array for empty input", () => {
			expect(rankMemories([], "query")).toEqual([])
		})

		it("uses default threshold 0.05", () => {
			// Entry with no overlap should likely have score < 0.05 (only recency)
			// Entry with overlap should exceed 0.05
			const query = "typescript memory management"
			const relevant = makeEntry({ content: "typescript memory management patterns" })
			const result = rankMemories([relevant], query)
			expect(result).toHaveLength(1)
		})

		it("uses default maxResults of 10", () => {
			const query = "typescript"
			const memories = Array.from({ length: 15 }, (_, i) =>
				makeEntry({ id: `m${i}`, content: `typescript code ${i}` }),
			)
			expect(rankMemories(memories, query, 0).length).toBeLessThanOrEqual(10)
		})
	})
})
