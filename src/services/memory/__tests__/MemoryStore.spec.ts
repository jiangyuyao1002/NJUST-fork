import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import { loadMemories, saveMemory, pruneExpiredMemories, MEMORY_TTL, type MemoryEntry } from "../MemoryStore"

vi.mock("fs/promises", () => ({
	readdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	rename: vi.fn(),
	mkdir: vi.fn(),
	unlink: vi.fn(),
}))

vi.mock("../../../core/condense/sessionMemoryCompact", () => ({
	SESSION_MEMORIES_DIR: ".roo/session-memories",
}))

const WORKSPACE = "/fake/workspace"

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id: "abc12345",
		type: "session",
		timestamp: Date.now(),
		content: "test memory content",
		tags: ["test"],
		source: "spec",
		...overrides,
	}
}

describe("MemoryStore", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(1_700_000_000_000)
		vi.clearAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined as unknown as string)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.rename).mockResolvedValue(undefined)
		vi.mocked(fs.unlink).mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("MEMORY_TTL", () => {
		it("defines TTL for all memory types", () => {
			expect(MEMORY_TTL.session).toBeGreaterThan(0)
			expect(MEMORY_TTL.user_feedback).toBeGreaterThan(0)
			expect(MEMORY_TTL.project).toBeGreaterThan(MEMORY_TTL.session)
			expect(MEMORY_TTL.reference).toBeGreaterThan(MEMORY_TTL.project)
		})
	})

	describe("loadMemories", () => {
		it("returns empty array when directory read fails", async () => {
			vi.mocked(fs.readdir).mockRejectedValueOnce(new Error("ENOENT"))
			expect(await loadMemories(WORKSPACE)).toEqual([])
		})

		it("returns empty array when no memory files found", async () => {
			vi.mocked(fs.readdir).mockResolvedValueOnce(["other.txt"] as unknown as string[])
			expect(await loadMemories(WORKSPACE)).toEqual([])
		})

		it("loads and returns valid non-expired entries", async () => {
			const entry = makeEntry({ timestamp: Date.now() })
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-${entry.timestamp}-abc12345.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(entry) as unknown as Buffer)
			const result = await loadMemories(WORKSPACE)
			expect(result).toHaveLength(1)
			expect(result[0]!.id).toBe("abc12345")
		})

		it("filters out expired entries and unlinks them", async () => {
			const expiredEntry = makeEntry({
				type: "session",
				timestamp: Date.now() - MEMORY_TTL.session - 1000, // expired
			})
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-${expiredEntry.timestamp}-abc12345.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(expiredEntry) as unknown as Buffer)
			const result = await loadMemories(WORKSPACE)
			expect(result).toHaveLength(0)
		})

		it("filters by type when type argument provided", async () => {
			const sessionEntry = makeEntry({ type: "session" })
			const projectEntry = makeEntry({ id: "proj1111", type: "project", timestamp: Date.now() - 100 })
			vi.mocked(fs.readdir).mockResolvedValueOnce([
				`memory-${sessionEntry.timestamp}-abc12345.json`,
				`memory-${projectEntry.timestamp}-proj1111.json`,
			] as unknown as string[])
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(sessionEntry) as unknown as Buffer)
				.mockResolvedValueOnce(JSON.stringify(projectEntry) as unknown as Buffer)
			const result = await loadMemories(WORKSPACE, "project")
			expect(result).toHaveLength(1)
			expect(result[0]!.type).toBe("project")
		})

		it("skips corrupted files without throwing", async () => {
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-1234-abcd1234.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce("not valid json" as unknown as Buffer)
			await expect(loadMemories(WORKSPACE)).resolves.toEqual([])
		})

		it("returns entries sorted by timestamp descending", async () => {
			const older = makeEntry({ id: "old11111", timestamp: Date.now() - 1000 })
			const newer = makeEntry({ id: "new11111", timestamp: Date.now() })
			vi.mocked(fs.readdir).mockResolvedValueOnce([
				`memory-${older.timestamp}-old11111.json`,
				`memory-${newer.timestamp}-new11111.json`,
			] as unknown as string[])
			vi.mocked(fs.readFile)
				.mockResolvedValueOnce(JSON.stringify(older) as unknown as Buffer)
				.mockResolvedValueOnce(JSON.stringify(newer) as unknown as Buffer)
			const result = await loadMemories(WORKSPACE)
			expect(result[0]!.id).toBe("new11111")
			expect(result[1]!.id).toBe("old11111")
		})
	})

	describe("saveMemory", () => {
		it("creates directory and writes file via tmp+rename", async () => {
			const entry = makeEntry()
			await saveMemory(entry, WORKSPACE)
			expect(fs.mkdir).toHaveBeenCalled()
			expect(fs.writeFile).toHaveBeenCalled()
			expect(fs.rename).toHaveBeenCalled()
		})

		it("writes valid JSON content", async () => {
			const entry = makeEntry()
			await saveMemory(entry, WORKSPACE)
			const [, content] = vi.mocked(fs.writeFile).mock.calls[0] as [string, string, string]
			const parsed = JSON.parse(content) as MemoryEntry
			expect(parsed.id).toBe(entry.id)
			expect(parsed.type).toBe(entry.type)
			expect(parsed.content).toBe(entry.content)
		})

		it("generates filename with timestamp and id prefix", async () => {
			const entry = makeEntry({ timestamp: 1700000000000, id: "deadbeef" })
			await saveMemory(entry, WORKSPACE)
			const [tmpPath] = vi.mocked(fs.writeFile).mock.calls[0] as [string, string, string]
			expect(tmpPath).toContain("1700000000000")
			expect(tmpPath).toContain("deadbeef")
		})
	})

	describe("pruneExpiredMemories", () => {
		it("returns 0 when directory does not exist", async () => {
			vi.mocked(fs.readdir).mockRejectedValueOnce(new Error("ENOENT"))
			expect(await pruneExpiredMemories(WORKSPACE)).toBe(0)
		})

		it("removes expired entries and returns count", async () => {
			const expired = makeEntry({
				type: "session",
				timestamp: Date.now() - MEMORY_TTL.session - 1000,
			})
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-${expired.timestamp}-abc12345.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(expired) as unknown as Buffer)
			const removed = await pruneExpiredMemories(WORKSPACE)
			expect(removed).toBe(1)
			expect(fs.unlink).toHaveBeenCalledTimes(1)
		})

		it("does not remove valid entries", async () => {
			const valid = makeEntry({ timestamp: Date.now() })
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-${valid.timestamp}-abc12345.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(valid) as unknown as Buffer)
			const removed = await pruneExpiredMemories(WORKSPACE)
			expect(removed).toBe(0)
			expect(fs.unlink).not.toHaveBeenCalled()
		})

		it("skips corrupted files without throwing", async () => {
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-1234-abcd1234.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce("corrupted" as unknown as Buffer)
			await expect(pruneExpiredMemories(WORKSPACE)).resolves.toBe(0)
		})

		it("respects type-specific TTL (reference lives longer than session)", async () => {
			// An entry that's expired for session but not for reference
			const ageMs = MEMORY_TTL.session + 1000 // past session TTL
			const refEntry = makeEntry({ type: "reference", timestamp: Date.now() - ageMs })
			vi.mocked(fs.readdir).mockResolvedValueOnce([`memory-${refEntry.timestamp}-abc12345.json`] as unknown as string[])
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(refEntry) as unknown as Buffer)
			// reference TTL is 90 days, so this should NOT be pruned
			const removed = await pruneExpiredMemories(WORKSPACE)
			expect(removed).toBe(0)
		})
	})
})
