import { describe, expect, it } from "vitest"

import {
	buildBudgetedSessionMemoryPrompt,
	formatSessionMemoriesForPrompt,
	type SessionMemory,
	type SessionMemorySummary,
} from "../sessionMemoryCompact"

describe("sessionMemoryCompact", () => {
	it("buildBudgetedSessionMemoryPrompt trims to bounded size while preserving key sections", () => {
		const memory: SessionMemory = {
			modifiedFiles: Array.from({ length: 120 }, (_, i) => `src/file-${i}.ts`),
			decisions: Array.from({ length: 80 }, (_, i) => `decision-${i} with detailed explanation`),
			pendingTasks: Array.from({ length: 50 }, (_, i) => `pending-task-${i}`),
			discoveredPatterns: Array.from({ length: 40 }, (_, i) => `pattern-${i}`),
			errorResolutions: Array.from({ length: 40 }, (_, i) => ({
				error: `error-${i}`,
				resolution: `resolution-${i}`,
			})),
			timestamp: Date.now(),
		}

		const prompt = buildBudgetedSessionMemoryPrompt(memory)
		expect(prompt.length).toBeLessThanOrEqual(3000)
		expect(prompt).toContain("Modified files")
		expect(prompt).toContain("Pending tasks")
	})

	it("formatSessionMemoriesForPrompt respects token budget with fallback minimal section", () => {
		const memories: SessionMemorySummary[] = [
			{
				sessionId: "task-abcdef01",
				timestamp: Date.now(),
				summary: "A very long summary ".repeat(2),
				filesModified: Array.from({ length: 25 }, (_, i) => `src/mod-${i}.ts`),
				filesRead: [],
				toolsUsed: ["read_file", "search_files", "write_to_file"],
				keyDecisions: Array.from({ length: 10 }, (_, i) => `decision-${i}`),
				unresolvedIssues: Array.from({ length: 6 }, (_, i) => `issue-${i}`),
				tokenCount: 1200,
			},
		]

		const out = formatSessionMemoriesForPrompt(memories, 120)
		expect(out.length).toBeGreaterThan(0)
		expect(out).toContain("Session:")
		expect(out).toContain("task-abc")
	})
})
