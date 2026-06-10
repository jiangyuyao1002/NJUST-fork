import { describe, expect, it } from "vitest"

import {
	buildCacheAwareForkContext,
	buildForkedContext,
	buildForkPlaceholderResult,
	extractEssentialContext,
	extractRelevantFiles,
	generateParentContextSummary,
	generateTaskResultSummary,
} from "../SubTaskContextBuilder"

describe("SubTaskContextBuilder", () => {
	it("extracts relevant files from common path formats and excludes globs", () => {
		const files = extractRelevantFiles(
			"Edit ./src/app.ts, `tests/foo.spec.ts`, src/lib/util.ts, ignore src/**/*.ts",
		)

		expect(files).toEqual(["./src/app.ts", "tests/foo.spec.ts", "src/app.ts", "src/lib/util.ts"])
	})

	it("extracts recent assistant context and truncates from the tail", () => {
		const context = extractEssentialContext(
			[
				{ role: "user", content: "ignore" },
				{ role: "assistant", content: "old" },
				{ role: "assistant", content: "x".repeat(1200) },
				{ role: "assistant", content: "latest" },
			],
			40,
		)

		expect(context.length).toBeLessThanOrEqual(40)
		expect(context).toContain("latest")
	})

	it("builds forked context with default budget", () => {
		const context = buildForkedContext("Read src/a.ts", [{ role: "assistant", content: "decision" }], {} as any)

		expect(context).toEqual({
			taskDescription: "Read src/a.ts",
			relevantFiles: ["src/a.ts"],
			essentialContext: "decision",
			contextBudget: 64_000,
		})
	})

	it("generates parent summaries with files commands and recent context", () => {
		const summary = generateParentContextSummary(
			[
				{ role: "assistant", content: 'write_to_file path "src/a.ts"\nexecute_command command "pnpm test"' },
				{ role: "user", content: [{ type: "text", text: "read_file path src/b.ts" }] },
				{ role: "assistant", content: "final decision" },
			],
			1000,
			{ maxRecentMessages: 5, includeFileChanges: true, includeCommands: true },
		)

		expect(summary).toContain("[Files referenced]")
		expect(summary).toContain("src/a.ts")
		expect(summary).toContain("[Commands executed]")
		expect(summary).toContain("pnpm test")
		expect(summary).toContain("[Recent context]")
	})

	it("returns default parent summary when no context is available", () => {
		expect(generateParentContextSummary([], 1000)).toBe("(No parent context available)")
	})

	it("builds cache-aware fork context from parent prefix", () => {
		const cacheSafeParams = {
			forkContextMessages: [{ role: "assistant", content: "prefix" }],
			systemPromptHash: "hash",
		} as any

		const result = buildCacheAwareForkContext("child task", cacheSafeParams)

		expect(result.messages).toEqual([
			{ role: "assistant", content: "prefix" },
			{ role: "user", content: "child task" },
		])
		expect(result.cacheSafeParams).toBe(cacheSafeParams)
	})

	it("builds fork placeholder tool result", () => {
		expect(buildForkPlaceholderResult("tool-1", "started")).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tool-1", content: "started" }],
		})
	})

	it("generates task result summaries with files commands and conclusion", () => {
		const summary = generateTaskResultSummary("child-1", [
			{ role: "assistant", content: 'apply_diff path "src/a.ts"\ncommand "pnpm test"' },
			{ role: "assistant", content: [{ type: "text", text: "All done" }] },
		])

		expect(summary).toContain("[Subtask child-1 completed]")
		expect(summary).toContain("Files modified: src/a.ts")
		expect(summary).toContain("Commands executed: pnpm test")
		expect(summary).toContain("Conclusion: All done")
	})

	it("truncates long task result summaries", () => {
		const summary = generateTaskResultSummary("child-1", [{ role: "assistant", content: "x".repeat(500) }], 180)

		expect(summary.length).toBeLessThanOrEqual(180)
		expect(summary).toContain("...")
	})
})
