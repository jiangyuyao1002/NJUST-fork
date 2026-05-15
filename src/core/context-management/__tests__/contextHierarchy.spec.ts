import { beforeEach, describe, expect, it } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	buildContextHierarchy,
	computeFileHotness,
	computeTurnImportance,
	computeTurnSelfAttentionMean,
	findTurnIndex,
	getAllTurnImportances,
	getQueryAttention,
	jaccardSimilarity,
	resetAdaptiveParams,
	tokenizeForRelevance,
} from "../contextHierarchy"

const makeConversation = (): ApiMessage[] => [
	{ role: "user", content: "Read src/app.ts and explain startup flow" },
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "read-1",
				name: "read_file",
				input: { path: "src/app.ts" },
			},
		],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "read-1", content: "export function start() {}" }],
	},
	{ role: "assistant", content: "The startup flow calls start." },
	{ role: "user", content: "Update src/app.ts to handle errors" },
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "write-1",
				name: "apply_diff",
				input: { path: "src/app.ts" },
			},
		],
	},
	{
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "write-1", content: "failed with error" }],
	},
	{ role: "assistant", content: "The error handling update failed and needs retry." },
	{ role: "user", content: "Now inspect src/config.ts" },
	{
		role: "assistant",
		content: [
			{
				type: "tool_use",
				id: "read-2",
				name: "read_file",
				input: { path: "src/config.ts" },
			},
		],
	},
]

describe("contextHierarchy", () => {
	beforeEach(() => {
		resetAdaptiveParams()
	})

	describe("tokenizeForRelevance", () => {
		it("tokenizes lowercase English words with digits and underscores", () => {
			expect([...tokenizeForRelevance("Read src_app.ts, HTTP2 startup flow!")].sort()).toEqual([
				"flow",
				"http2",
				"read",
				"src_app",
				"startup",
			])
		})

		it("filters short words and symbols", () => {
			expect([...tokenizeForRelevance("a bb c++ !! ok")]).toEqual([])
		})
	})

	describe("jaccardSimilarity", () => {
		it("returns 1 for identical non-empty sets", () => {
			expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1)
		})

		it("returns 0 for disjoint or empty sets", () => {
			expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0)
			expect(jaccardSimilarity(new Set(), new Set(["b"]))).toBe(0)
		})

		it("returns the intersection over union for partial overlap", () => {
			expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3)
		})
	})

	describe("buildContextHierarchy", () => {
		it("returns null for conversations with fewer than three turns", () => {
			expect(buildContextHierarchy([{ role: "user", content: "hello" }])).toBeNull()
		})

		it("builds turn metadata, file graph, and message lookup for a multi-turn conversation", () => {
			const hierarchy = buildContextHierarchy(makeConversation(), "task-1")

			expect(hierarchy?.turnCount).toBe(3)
			expect(hierarchy?.turns[0]?.toolNames.has("read_file")).toBe(true)
			expect(hierarchy?.turns[1]?.hasWriteOp).toBe(true)
			expect(hierarchy?.turns[1]?.hasError).toBe(true)
			expect(hierarchy?.files.get("src/app.ts")?.referenceCount).toBe(2)
			expect(hierarchy ? findTurnIndex(hierarchy, 4) : -1).toBe(1)
		})

		it("keeps adaptive parameters task-scoped and resettable", () => {
			const first = buildContextHierarchy(makeConversation(), "task-ema")?.adaptiveParams
			const second = buildContextHierarchy(makeConversation(), "task-ema")?.adaptiveParams
			resetAdaptiveParams("task-ema")
			const afterReset = buildContextHierarchy(makeConversation(), "task-ema")?.adaptiveParams

			expect(second).toEqual(first)
			expect(afterReset).toEqual(first)
		})
	})

	describe("turn scoring helpers", () => {
		it("computes bounded attention, importance, hotness, and query scores", () => {
			const hierarchy = buildContextHierarchy(makeConversation(), "task-score")
			expect(hierarchy).not.toBeNull()
			if (!hierarchy) return

			expect(computeTurnSelfAttentionMean(hierarchy, 0)).toBeGreaterThan(0)
			expect(computeTurnSelfAttentionMean(hierarchy, -1)).toBe(0)
			expect(computeTurnImportance(hierarchy)).toBeGreaterThan(0)
			expect(getAllTurnImportances(hierarchy)).toHaveLength(hierarchy.turnCount)
			expect(computeFileHotness(hierarchy, 0)).toBeGreaterThan(0)
			expect(computeFileHotness(hierarchy, 99)).toBe(0)
			expect(getQueryAttention(hierarchy, 0)).toBeGreaterThanOrEqual(0)
			expect(getQueryAttention(hierarchy, 99)).toBe(0)
		})
	})
})
