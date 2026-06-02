import { describe, expect, it, vi, beforeEach } from "vitest"
import {
	postCompactRestore,
	POST_COMPACT_MAX_FILES_TO_RESTORE,
	POST_COMPACT_TOKEN_BUDGET,
	POST_COMPACT_MAX_TOKENS_PER_FILE,
	POST_COMPACT_MAX_TOKENS_PER_SKILL,
} from "../postCompactRestore"
import type { ApiMessage } from "../../task-persistence/apiMessages"

// Mock fs module
vi.mock("fs", () => ({
	readFileSync: vi.fn(),
}))

import * as fs from "fs"
const mockReadFileSync = vi.mocked(fs.readFileSync)

describe("postCompactRestore", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns same messages when no options provided", () => {
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		expect(postCompactRestore(input)).toBe(input)
	})

	it("returns same messages when options are empty", () => {
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		expect(postCompactRestore(input, {})).toBe(input)
	})

	it("exports expected constants", () => {
		expect(POST_COMPACT_MAX_FILES_TO_RESTORE).toBe(5)
		expect(POST_COMPACT_TOKEN_BUDGET).toBe(50_000)
		expect(POST_COMPACT_MAX_TOKENS_PER_FILE).toBe(5_000)
		expect(POST_COMPACT_MAX_TOKENS_PER_SKILL).toBe(5_000)
	})

	it("reads file content and appends restore message", () => {
		mockReadFileSync.mockReturnValue("const x = 1;")
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		const out = postCompactRestore(input, { recentFiles: ["a.ts"] })
		expect(out.length).toBe(input.length + 1)
		const last = String(out[out.length - 1].content)
		expect(last).toContain("[Context restored after compaction")
		expect(last).toContain("### File: a.ts")
		expect(last).toContain("const x = 1;")
		expect(mockReadFileSync).toHaveBeenCalledWith("a.ts", "utf-8")
	})

	it("gracefully handles unreadable files", () => {
		mockReadFileSync.mockImplementation(function () {
			throw new Error("ENOENT")
		})
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		const out = postCompactRestore(input, { recentFiles: ["missing.ts"] })
		expect(out.length).toBe(input.length + 1)
		const last = String(out[out.length - 1].content)
		expect(last).toContain("file no longer available")
	})

	it("limits files to POST_COMPACT_MAX_FILES_TO_RESTORE", () => {
		mockReadFileSync.mockReturnValue("content")
		const files = Array.from({ length: 10 }, (_, i) => `file${i}.ts`)
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		postCompactRestore(input, { recentFiles: files })
		expect(mockReadFileSync).toHaveBeenCalledTimes(POST_COMPACT_MAX_FILES_TO_RESTORE)
	})

	it("truncates large file content to token budget", () => {
		// Create content larger than POST_COMPACT_MAX_TOKENS_PER_FILE * 4 chars
		const largeContent = "x".repeat(POST_COMPACT_MAX_TOKENS_PER_FILE * 4 + 1000)
		mockReadFileSync.mockReturnValue(largeContent)
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		const out = postCompactRestore(input, { recentFiles: ["big.ts"] })
		const last = String(out[out.length - 1].content)
		expect(last).toContain("truncated:")
		expect(last).toContain("tokens omitted")
	})

	it("restores active skills", () => {
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		const out = postCompactRestore(input, {
			activeSkills: [
				{ name: "skill-a", content: "skill-a content" },
				{ name: "skill-b", content: "skill-b content" },
			],
		})
		expect(out.length).toBe(input.length + 1)
		const last = String(out[out.length - 1].content)
		expect(last).toContain("Active Skill: skill-a")
		expect(last).toContain("Active Skill: skill-b")
	})

	it("restores MCP delta", () => {
		const input: ApiMessage[] = [{ role: "user", content: "x", ts: Date.now() }]
		const out = postCompactRestore(input, { mcpDelta: "some mcp info" })
		expect(out.length).toBe(input.length + 1)
		const last = String(out[out.length - 1].content)
		expect(last).toContain("MCP Context")
		expect(last).toContain("some mcp info")
	})
})
