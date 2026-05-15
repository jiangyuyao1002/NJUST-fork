import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"

import {
	buildSessionMemoryPrompt,
	buildBudgetedSessionMemoryPrompt,
	extractSessionMemory,
	formatSessionMemoriesForPrompt,
	generateAwaySummary,
	generateSessionSummary,
	loadSessionMemories,
	mergeSessionMemories,
	persistSessionMemory,
	SESSION_MEMORIES_DIR,
	type SessionMemory,
	type SessionMemorySummary,
} from "../sessionMemoryCompact"

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn(),
	readFile: vi.fn(),
	unlink: vi.fn(),
}))

describe("sessionMemoryCompact", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_000_000)
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const baseMemory = (overrides: Partial<SessionMemory> = {}): SessionMemory => ({
		modifiedFiles: [],
		decisions: [],
		pendingTasks: [],
		discoveredPatterns: [],
		errorResolutions: [],
		timestamp: Date.now(),
		...overrides,
	})

	const baseSummary = (overrides: Partial<SessionMemorySummary> = {}): SessionMemorySummary => ({
		sessionId: "task-abcdef01",
		timestamp: Date.now(),
		summary: "Implemented the requested flow.",
		filesModified: [],
		filesRead: [],
		toolsUsed: [],
		keyDecisions: [],
		unresolvedIssues: [],
		tokenCount: 100,
		...overrides,
	})

	describe("buildSessionMemoryPrompt", () => {
		it("renders every populated session memory section", () => {
			const prompt = buildSessionMemoryPrompt(
				baseMemory({
					modifiedFiles: ["src/app.ts", "src/config.ts"],
					decisions: ["use the local cache as the edit buffer"],
					pendingTasks: ["add integration coverage"],
					discoveredPatterns: ["settings inputs bind to cachedState"],
					errorResolutions: [{ error: "race condition", resolution: "defer source update until save" }],
				}),
			)

			expect(prompt).toContain("## Previous Session Context")
			expect(prompt).toContain("**Modified files:** src/app.ts, src/config.ts")
			expect(prompt).toContain("- use the local cache as the edit buffer")
			expect(prompt).toContain("- add integration coverage")
			expect(prompt).toContain("- settings inputs bind to cachedState")
			expect(prompt).toContain("race condition")
			expect(prompt).toContain("defer source update until save")
		})

		it("renders only the heading for an empty session memory", () => {
			expect(buildSessionMemoryPrompt(baseMemory())).toBe("## Previous Session Context")
		})
	})

	describe("extractSessionMemory", () => {
		it("extracts modified files and decisions from assistant messages", () => {
			const memory = extractSessionMemory([
				{ role: "user", content: "please update the extension" },
				{
					role: "assistant",
					content:
						"Created src/newFeature.ts. Modified `src/existing.ts`. I'll use cachedState for settings edits.",
				},
				{
					role: "assistant",
					content:
						"apply_diff path: src/newFeature.ts. decision: keep the mock server protocol stable.",
				},
			])

			expect(memory.modifiedFiles).toEqual(["src/newFeature.ts", "src/existing.ts"])
			expect(memory.decisions).toEqual([
				"cachedState for settings edits",
				"keep the mock server protocol stable",
			])
			expect(memory.timestamp).toBe(Date.now())
		})

		it("ignores user messages and deduplicates repeated matches", () => {
			const memory = extractSessionMemory([
				{ role: "user", content: "Created src/userOnly.ts. decision: this should not be captured." },
				{ role: "assistant", content: "Updated src/app.ts. Updated src/app.ts." },
			])

			expect(memory.modifiedFiles).toEqual(["src/app.ts"])
			expect(memory.decisions).toEqual([])
		})

		it("returns an empty memory when no extraction patterns match", () => {
			const memory = extractSessionMemory([{ role: "assistant", content: "All set." }])

			expect(memory).toEqual(baseMemory())
		})
	})

	describe("mergeSessionMemories", () => {
		it("returns an empty memory for empty input", () => {
			expect(mergeSessionMemories([])).toEqual(baseMemory())
		})

		it("merges memories newest first while deduplicating set-like fields", () => {
			const older = baseMemory({
				timestamp: 100,
				modifiedFiles: ["src/a.ts", "src/shared.ts"],
				decisions: ["older decision"],
				pendingTasks: ["old task"],
				discoveredPatterns: ["pattern-a"],
				errorResolutions: [{ error: "old error", resolution: "old fix" }],
			})
			const newer = baseMemory({
				timestamp: 200,
				modifiedFiles: ["src/shared.ts", "src/b.ts"],
				decisions: ["newer decision"],
				pendingTasks: ["new task"],
				discoveredPatterns: ["pattern-a", "pattern-b"],
				errorResolutions: [{ error: "new error", resolution: "new fix" }],
			})

			const merged = mergeSessionMemories([older, newer])

			expect(merged.modifiedFiles).toEqual(["src/shared.ts", "src/b.ts", "src/a.ts"])
			expect(merged.decisions).toEqual(["newer decision", "older decision"])
			expect(merged.pendingTasks).toEqual(["new task"])
			expect(merged.discoveredPatterns).toEqual(["pattern-a", "pattern-b"])
			expect(merged.errorResolutions).toEqual([
				{ error: "new error", resolution: "new fix" },
				{ error: "old error", resolution: "old fix" },
			])
			expect(merged.timestamp).toBe(200)
		})

		it("limits long merged history fields", () => {
			const memories = [
				baseMemory({
					timestamp: 2,
					decisions: Array.from({ length: 25 }, (_, i) => `decision-${i}`),
					discoveredPatterns: Array.from({ length: 12 }, (_, i) => `pattern-${i}`),
					errorResolutions: Array.from({ length: 12 }, (_, i) => ({
						error: `error-${i}`,
						resolution: `resolution-${i}`,
					})),
				}),
			]

			const merged = mergeSessionMemories(memories)

			expect(merged.decisions).toHaveLength(20)
			expect(merged.discoveredPatterns).toHaveLength(10)
			expect(merged.errorResolutions).toHaveLength(10)
		})
	})

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

	it("buildBudgetedSessionMemoryPrompt keeps a short memory unchanged", () => {
		const memory = baseMemory({
			modifiedFiles: ["src/app.ts"],
			pendingTasks: ["run smoke tests"],
		})

		expect(buildBudgetedSessionMemoryPrompt(memory)).toBe(buildSessionMemoryPrompt(memory))
	})

	describe("generateSessionSummary", () => {
		it("summarizes task text, files, tools, decisions, and unresolved issues", () => {
			const summary = generateSessionSummary(
				[
					{ role: "user", content: "Add Cloud Agent deferred resume coverage" },
					{
						role: "assistant",
						content:
							"read_file path: src/core/task.ts. Created src/deferred.ts. I'll use the deferred protocol loop. TODO: add compile retry coverage.",
					},
				] as any,
				"task-12345678",
			)

			expect(summary).toMatchObject({
				sessionId: "task-12345678",
				timestamp: Date.now(),
				filesModified: ["src/deferred.ts"],
				filesRead: ["src/core/task.ts"],
				toolsUsed: ["read_file"],
				keyDecisions: ["the deferred protocol loop"],
				unresolvedIssues: ["add compile retry coverage"],
			})
			expect(summary.summary).toContain("Task: Add Cloud Agent deferred resume coverage")
			expect(summary.summary).toContain("Modified 1 files.")
			expect(summary.summary).toContain("Made 1 key decisions.")
			expect(summary.summary).toContain("1 issues remain unresolved.")
			expect(summary.tokenCount).toBeGreaterThan(0)
		})

		it("handles empty message history with stable empty fields", () => {
			const summary = generateSessionSummary([], "empty-task")
			expect(summary).toMatchObject({
				sessionId: "empty-task",
				timestamp: Date.now(),
				summary: "",
				filesModified: [],
				filesRead: [],
				toolsUsed: [],
				keyDecisions: [],
				unresolvedIssues: [],
			})
			expect(summary.tokenCount).toBeGreaterThan(0)
		})

		it("deduplicates and caps summary arrays", () => {
			const assistantText = [
				"read_file path: src/repeated.ts.",
				"read_file path: src/repeated.ts.",
				...Array.from({ length: 35 }, (_, i) => `Reading src/read-${i}.ts.`),
				...Array.from({ length: 20 }, (_, i) => `decision: choose stable option number ${i}.`),
				...Array.from({ length: 12 }, (_, i) => `TODO: unresolved issue number ${i}.`),
			].join(" ")

			const summary = generateSessionSummary([{ role: "assistant", content: assistantText } as any], "task-cap")

			expect(summary.filesRead).toHaveLength(30)
			expect(summary.filesRead.filter((file) => file === "src/repeated.ts")).toHaveLength(1)
			expect(summary.keyDecisions).toHaveLength(15)
			expect(summary.unresolvedIssues).toHaveLength(10)
		})
	})

	describe("formatSessionMemoriesForPrompt", () => {
		it("returns an empty string for no memories", () => {
			expect(formatSessionMemoriesForPrompt([], 100)).toBe("")
		})

		it("formats full session memory details within budget", () => {
			const out = formatSessionMemoriesForPrompt(
				[
					baseSummary({
						filesModified: ["src/app.ts"],
						toolsUsed: ["read_file", "write_to_file"],
						keyDecisions: ["keep cached state isolated"],
						unresolvedIssues: ["manual LSP smoke remains"],
					}),
				],
				500,
			)

			expect(out).toContain("### Session: 2023-11-14 22:13:20 (task-abc)")
			expect(out).toContain("Implemented the requested flow.")
			expect(out).toContain("**Modified files:** src/app.ts")
			expect(out).toContain("- keep cached state isolated")
			expect(out).toContain("- manual LSP smoke remains")
			expect(out).toContain("**Tools used:** read_file, write_to_file")
		})

		it("respects token budget with fallback minimal section", () => {
			const memories: SessionMemorySummary[] = [
				baseSummary({
					summary: "A very long summary ".repeat(2),
					filesModified: Array.from({ length: 25 }, (_, i) => `src/mod-${i}.ts`),
					toolsUsed: ["read_file", "search_files", "write_to_file"],
					keyDecisions: Array.from({ length: 10 }, (_, i) => `decision-${i}`),
					unresolvedIssues: Array.from({ length: 6 }, (_, i) => `issue-${i}`),
					tokenCount: 1200,
				}),
			]

			const out = formatSessionMemoriesForPrompt(memories, 120)
			expect(out.length).toBeGreaterThan(0)
			expect(out).toContain("Session:")
			expect(out).toContain("task-abc")
		})
	})

	describe("generateAwaySummary", () => {
		it("summarizes file changes, decisions, errors, and completion text", () => {
			const away = generateAwaySummary([
				{
					role: "assistant",
					content:
						'write_to_file path: src/app.ts. decided to keep fallback. error resolved. attempt_completion result: Finished the deferred execution smoke validation.',
				},
			])

			expect(away).toContain("Modified 1 file.")
			expect(away).toContain("Made 1 decision.")
			expect(away).toContain("Encountered 1 error that were resolved.")
			expect(away).toContain("Completed: Finished the deferred execution smoke validation.")
		})

		it("reads text blocks when message content is an array", () => {
			const away = generateAwaySummary([
				{
					role: "assistant",
					content: [
						{ type: "text", text: "apply_diff path: src/a.ts. choice: use FIFO trimming." },
						{ type: "image" },
					],
				},
			])

			expect(away).toContain("Modified 1 file.")
			expect(away).toContain("Made 1 decision.")
		})

		it("returns stable empty and default summaries", () => {
			expect(generateAwaySummary([])).toBe("")
			expect(generateAwaySummary([{ role: "assistant", content: "Still investigating." }])).toBe(
				"**While you were away:** Work continued on your previous request.",
			)
		})
	})

	describe("persistSessionMemory / loadSessionMemories", () => {
		const workspaceDir = "workspace"
		const sessionDir = path.join(workspaceDir, SESSION_MEMORIES_DIR)

		const mockValidSessionFile = (file: string) => {
			const timestamp = Number(file.split("-")[1])
			return JSON.stringify(
				baseSummary({
					sessionId: file.replace(/^session-\d+-/, "").replace(/\.json$/, ""),
					timestamp,
					summary: `summary ${timestamp}`,
				}),
			)
		}

		it("writes session memory through tmp file and atomic rename", async () => {
			vi.mocked(fs.readdir).mockResolvedValue([])
			const summary = baseSummary({
				sessionId: "task-abcdef01",
				timestamp: 1_700_000_000_000,
				summary: "Persisted session memory.",
			})

			await persistSessionMemory(summary, workspaceDir)

			const filePath = path.join(sessionDir, "session-1700000000000-task-abc.json")
			expect(fs.mkdir).toHaveBeenCalledWith(sessionDir, { recursive: true })
			expect(fs.writeFile).toHaveBeenCalledWith(`${filePath}.tmp`, expect.any(String), "utf-8")
			expect(fs.rename).toHaveBeenCalledWith(`${filePath}.tmp`, filePath)
			expect(JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string)).toMatchObject({
				sessionId: "task-abcdef01",
				summary: "Persisted session memory.",
			})
		})

		it("prunes old sessions beyond the retained session limit", async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				"session-1700000000000-a.json",
				"session-1700000000001-b.json",
				"session-1700000000002-c.json",
				"session-1700000000003-d.json",
				"session-1700000000004-e.json",
				"session-1700000000005-f.json",
				"session-1700000000006-g.json",
			])

			await persistSessionMemory(baseSummary({ timestamp: 1_700_000_000_010 }), workspaceDir)

			expect(fs.unlink).toHaveBeenCalledTimes(2)
			expect(fs.unlink).toHaveBeenNthCalledWith(1, path.join(sessionDir, "session-1700000000000-a.json"))
			expect(fs.unlink).toHaveBeenNthCalledWith(2, path.join(sessionDir, "session-1700000000001-b.json"))
		})

		it("loads session memories from newest to oldest", async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				"notes.txt",
				"session-1700000000001-a.json",
				"session-1700000000003-c.json",
				"session-1700000000002-b.json",
			])
			vi.mocked(fs.readFile).mockImplementation(async (file) => mockValidSessionFile(path.basename(String(file))))

			const memories = await loadSessionMemories(workspaceDir)

			expect(memories.map((memory) => memory.timestamp)).toEqual([
				1_700_000_000_003, 1_700_000_000_002, 1_700_000_000_001,
			])
		})

		it("respects maxCount when loading session memories", async () => {
			vi.mocked(fs.readdir).mockResolvedValue([
				"session-1700000000000-a.json",
				"session-1700000000001-b.json",
				"session-1700000000002-c.json",
				"session-1700000000003-d.json",
				"session-1700000000004-e.json",
			])
			vi.mocked(fs.readFile).mockImplementation(async (file) => mockValidSessionFile(path.basename(String(file))))

			const memories = await loadSessionMemories(workspaceDir, 3)

			expect(memories).toHaveLength(3)
			expect(memories.map((memory) => memory.timestamp)).toEqual([
				1_700_000_000_004, 1_700_000_000_003, 1_700_000_000_002,
			])
		})

		it("skips corrupted session memory files", async () => {
			vi.mocked(fs.readdir).mockResolvedValue(["session-1700000000002-good.json", "session-1700000000001-bad.json"])
			vi.mocked(fs.readFile).mockImplementation(async (file) => {
				const filename = path.basename(String(file))
				return filename.includes("bad") ? "{not json" : mockValidSessionFile(filename)
			})

			const memories = await loadSessionMemories(workspaceDir)

			expect(memories).toHaveLength(1)
			expect(memories[0]?.sessionId).toBe("good")
		})

		it("returns an empty array when the session directory does not exist", async () => {
			vi.mocked(fs.readdir).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }))

			await expect(loadSessionMemories(workspaceDir)).resolves.toEqual([])
		})

		it("returns an empty array for an empty session directory", async () => {
			vi.mocked(fs.readdir).mockResolvedValue([])

			await expect(loadSessionMemories(workspaceDir)).resolves.toEqual([])
		})
	})
})
