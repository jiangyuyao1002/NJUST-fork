import { describe, expect, it } from "vitest"

import { TaskResultAggregator, type SubtaskResult } from "../TaskResultAggregator"

function result(overrides: Partial<SubtaskResult>): SubtaskResult {
	return {
		taskId: "task-1",
		taskDescription: "do work",
		status: "completed",
		resultType: "general",
		filesModified: [],
		filesRead: [],
		commandsExecuted: [],
		summary: "done",
		duration: 1000,
		...overrides,
	}
}

describe("TaskResultAggregator", () => {
	it.each([
		["write_to_file changed a.ts", "code_modification"],
		["apply_diff patched file", "code_modification"],
		["execute_command npm test", "command_execution"],
		["search_files read_file list_files", "search_analysis"],
		["plain answer", "general"],
	] as const)("classifies %s as %s", (text, expected) => {
		const aggregator = new TaskResultAggregator()

		expect(aggregator.classifyResult([{ role: "assistant", content: text }], "task")).toBe(expected)
	})

	it("classifies text blocks from content arrays", () => {
		const aggregator = new TaskResultAggregator()

		expect(
			aggregator.classifyResult(
				[{ role: "assistant", content: [{ type: "text", text: "read_file src/app.ts" }] }],
				"task",
			),
		).toBe("search_analysis")
	})

	it("aggregates results by section and counts status", () => {
		const aggregator = new TaskResultAggregator()
		aggregator.addResult(result({ resultType: "code_modification", filesModified: ["a.ts"], summary: "patched" }))
		aggregator.addResult(result({ resultType: "search_analysis", filesRead: ["b.ts"], summary: "found" }))
		aggregator.addResult(result({ resultType: "command_execution", commandsExecuted: ["pnpm test"], summary: "green" }))
		aggregator.addResult(result({ status: "failed", error: "boom", duration: 2500 }))

		const aggregated = aggregator.aggregate()

		expect(aggregated.subtaskCount).toBe(4)
		expect(aggregated.successCount).toBe(3)
		expect(aggregated.failureCount).toBe(1)
		expect(aggregated.sections.map((section) => section.title)).toEqual([
			"Code Changes",
			"Analysis Results",
			"Command Results",
			"Failed Subtasks",
		])
	})

	it("formats aggregated result as a parent-context message", () => {
		const aggregator = new TaskResultAggregator()
		aggregator.addResult(result({ resultType: "general", summary: "general summary" }))
		aggregator.addResult(result({ status: "failed", error: "failed reason" }))

		const message = aggregator.formatAsMessage()

		expect(message).toContain("## Subtask Results (1/2 succeeded)")
		expect(message).toContain("### Other Results")
		expect(message).toContain("### Failed Subtasks")
		expect(message).toContain("failed. See")
	})

	it("resets collected results", () => {
		const aggregator = new TaskResultAggregator()
		aggregator.addResult(result({}))

		aggregator.reset()

		expect(aggregator.getResults()).toEqual([])
	})

	it("truncates oversized summaries under the aggregate budget", () => {
		const aggregator = new TaskResultAggregator()
		const large = "x".repeat(20000)
		for (let i = 0; i < 5; i++) {
			aggregator.addResult(result({ resultType: "general", summary: large }))
		}

		const aggregated = aggregator.aggregate()

		expect(aggregated.totalTokens).toBeLessThan(8100)
		expect(aggregated.sections[0]!.content).toContain("truncated")
	})
})
