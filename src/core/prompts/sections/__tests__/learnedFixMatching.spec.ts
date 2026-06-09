import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}))

vi.mock("../cangjie-context", () => ({
	getCangjiePromptServices: vi.fn().mockReturnValue({
		getCangjieErrorAnalyzer: () => ({
			CJC_ERROR_PATTERNS: [
				{ category: "type/mismatch", suggestion: "检查类型" },
				{ category: "syntax", suggestion: "检查语法" },
			],
		}),
		getCangjieSymbolIndex: () => null,
	}),
}))

vi.mock("../learnedFixesStorage", () => ({
	LEARNED_FIXES_FILE: "learned-fixes.json",
	LEARNED_FIXES_MAX_PATTERNS: 50,
	getLearnedFixesFileMtime: vi.fn().mockReturnValue(0),
	loadLearnedFixes: vi.fn().mockReturnValue({ patterns: [] }),
	saveLearnedFixes: vi.fn(),
}))

vi.mock("./cacheManagement", () => ({
	readFileUtf8Lru: vi.fn().mockResolvedValue(null),
}))

vi.mock("./diagnosticHandling", () => ({
	normalizeDiagnosticMessageForAggregation: vi.fn().mockReturnValue(""),
}))

vi.mock("../CangjieErrorAnalyzer", () => ({
	normalizeDiagnosticCode: vi.fn().mockReturnValue(null),
	resolveCjcPatternForDiagnostic: vi.fn().mockReturnValue(null),
	buildDiagnosticPatternCache: vi.fn(),
}))

vi.mock("../CangjieImportParser", () => ({
	extractImports: vi.fn().mockReturnValue([]),
}))

import { normalizeForSimilarity, levenshteinDistance, stringSimilarity } from "../cangjieContext/learnedFixMatching"

describe("learnedFixMatching", () => {
	describe("normalizeForSimilarity", () => {
		it("normalizes file paths to FILE placeholder", () => {
			const result = normalizeForSimilarity("error in C:\\Users\\test\\file.cj:10:5")
			expect(result).toContain("FILE")
			expect(result).not.toContain("C:\\Users")
		})

		it("normalizes line numbers to L placeholder", () => {
			const result = normalizeForSimilarity("error at line 42")
			expect(result).toContain("line L")
		})

		it("normalizes :line:col to :L:L", () => {
			const result = normalizeForSimilarity("error:10:5")
			expect(result).toContain(":L:L")
		})

		it("converts to lowercase", () => {
			const result = normalizeForSimilarity("ERROR MESSAGE")
			expect(result).toBe(result.toLowerCase())
		})

		it("strips leading rule code brackets", () => {
			const result = normalizeForSimilarity("[RULE001] some error")
			expect(result).not.toContain("[RULE001]")
			expect(result).toContain("some error")
		})

		it("collapses whitespace", () => {
			const result = normalizeForSimilarity("  multiple   spaces  ")
			expect(result).not.toMatch(/\s{2,}/)
		})
	})

	describe("levenshteinDistance", () => {
		it("returns 0 for identical strings", () => {
			expect(levenshteinDistance("abc", "abc")).toBe(0)
		})

		it("returns length of other string when one is empty", () => {
			expect(levenshteinDistance("", "abc")).toBe(3)
			expect(levenshteinDistance("abc", "")).toBe(3)
		})

		it("returns 1 for single character difference", () => {
			expect(levenshteinDistance("abc", "abd")).toBe(1)
		})

		it("calculates correct distance for different strings", () => {
			expect(levenshteinDistance("kitten", "sitting")).toBe(3)
		})

		it("handles completely different strings", () => {
			expect(levenshteinDistance("abc", "xyz")).toBe(3)
		})
	})

	describe("stringSimilarity", () => {
		it("returns 1 for identical strings", () => {
			expect(stringSimilarity("abc", "abc")).toBe(1)
		})

		it("returns 1 for empty strings", () => {
			expect(stringSimilarity("", "")).toBe(1)
		})

		it("returns 0 for very different length strings", () => {
			expect(stringSimilarity("a", "abcdefghij")).toBe(0)
		})

		it("returns high value for similar strings", () => {
			const result = stringSimilarity("hello", "helo")
			expect(result).toBeGreaterThan(0.7)
		})

		it("returns 0 for completely different same-length strings", () => {
			expect(stringSimilarity("abc", "xyz")).toBe(0)
		})
	})
})
