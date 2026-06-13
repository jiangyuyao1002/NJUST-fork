import { describe, it, expect, vi } from "vitest"

vi.mock("../cangjie-context", () => ({
	getCangjiePromptServices: vi.fn(() => ({
		getCangjieErrorAnalyzer: vi.fn(() => ({
			CJC_ERROR_PATTERNS: [],
		})),
	})),
}))
vi.mock("../CangjieErrorAnalyzer", () => ({
	normalizeDiagnosticCode: vi.fn(() => null),
}))
vi.mock("../learnedFixesStorage", () => ({
	LEARNED_FIXES_FILE: "learned-fixes.json",
	LEARNED_FIXES_MAX_PATTERNS: 100,
	getLearnedFixesFileMtime: vi.fn(() => 0),
	loadLearnedFixes: vi.fn(() => ({ patterns: [] })),
	saveLearnedFixes: vi.fn(),
}))
vi.mock("../../../../shared/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { normalizeForSimilarity, levenshteinDistance, stringSimilarity, testNormalizeLearnedFixText } = await import(
	"../learnedFixMatching"
)

describe("normalizeForSimilarity", () => {
	it("lowercases text", () => {
		expect(normalizeForSimilarity("Type Mismatch Error")).toBe("type mismatch error")
	})

	it("converts CRLF to LF", () => {
		expect(normalizeForSimilarity("line1\u000d\u000aline2")).not.toContain("\u000d")
	})

	it("removes bracket prefixes", () => {
		const result = normalizeForSimilarity("[E0001] type mismatch")
		expect(result).not.toContain("[E0001]")
		expect(result).toContain("type mismatch")
	})

	it("replaces Windows absolute paths with FILE", () => {
		const result = normalizeForSimilarity("error in C:/path/to/file.cj:42")
		expect(result).toContain("FILE")
		expect(result).not.toContain("C:/")
	})

	it("replaces Unix absolute paths ending in .cj with FILE", () => {
		const result = normalizeForSimilarity("error in /home/user/project/src/main.cj")
		expect(result).toContain("FILE")
	})

	it("replaces line:column markers", () => {
		const result = normalizeForSimilarity("error at src/main.cj:10:5")
		expect(result).toContain(":L:L")
	})

	it("replaces single line numbers", () => {
		const result = normalizeForSimilarity("error at line 42 something went wrong")
		expect(result).toContain("line L")
	})

	it("normalizes whitespace", () => {
		expect(normalizeForSimilarity("hello    world")).toBe("hello world")
	})

	it("preserves already normalized text", () => {
		const t = "type mismatch expected int64 got string"
		expect(normalizeForSimilarity(t)).toBe(t)
	})

	it("handles empty string", () => {
		expect(normalizeForSimilarity("")).toBe("")
	})
})

describe("testNormalizeLearnedFixText", () => {
	it("delegates to normalizeForSimilarity", () => {
		expect(testNormalizeLearnedFixText("Type Error")).toBe("type error")
	})
})

describe("levenshteinDistance", () => {
	it("returns 0 for identical strings", () => {
		expect(levenshteinDistance("abc", "abc")).toBe(0)
	})

	it("returns length of non-empty when other is empty", () => {
		expect(levenshteinDistance("abc", "")).toBe(3)
		expect(levenshteinDistance("", "abc")).toBe(3)
	})

	it("returns 1 for single insertion", () => {
		expect(levenshteinDistance("cat", "cats")).toBe(1)
	})

	it("returns 1 for single deletion", () => {
		expect(levenshteinDistance("cats", "cat")).toBe(1)
	})

	it("returns 1 for single substitution", () => {
		expect(levenshteinDistance("cat", "bat")).toBe(1)
	})

	it("handles classic examples", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3)
		expect(levenshteinDistance("flaw", "lawn")).toBe(2)
	})

	it("handles empty strings", () => {
		expect(levenshteinDistance("", "")).toBe(0)
	})
})

describe("stringSimilarity", () => {
	it("returns 1 for identical strings", () => {
		expect(stringSimilarity("hello", "hello")).toBe(1)
	})

	it("returns 0 when length difference > 40 percent", () => {
		expect(stringSimilarity("a", "abcdefghijk")).toBe(0)
	})

	it("returns high score for similar strings", () => {
		const s = stringSimilarity("type mismatch", "type mismatched")
		expect(s).toBeGreaterThan(0.85)
	})

	it("returns lower score for different strings", () => {
		const s = stringSimilarity("abc", "xyz")
		expect(s).toBeLessThan(0.5)
	})

	it("returns 1 for both empty strings", () => {
		expect(stringSimilarity("", "")).toBe(1)
	})
})
