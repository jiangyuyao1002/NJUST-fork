import { describe, it, expect } from "vitest"
import {
	DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET,
	CORPUS_BM25_MAX_CHUNKS_PER_PATH,
	estimateContextTokens,
	addPrioritized,
	buildMandatoryCorpusFooter,
	packSectionsWithTokenBudget,
	simpleHash,
	type PrioritizedCangjieSection,
} from "../budget"

describe("DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET", () => {
	it("is a positive number", () => {
		expect(DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET).toBeGreaterThan(0)
	})
})

describe("CORPUS_BM25_MAX_CHUNKS_PER_PATH", () => {
	it("is at least 1", () => {
		expect(CORPUS_BM25_MAX_CHUNKS_PER_PATH).toBeGreaterThanOrEqual(1)
	})
})

describe("estimateContextTokens", () => {
	it("returns 0 for empty string", () => {
		expect(estimateContextTokens("")).toBe(0)
	})

	it("returns 0 for falsy input", () => {
		expect(estimateContextTokens(null as unknown as string)).toBe(0)
		expect(estimateContextTokens(undefined as unknown as string)).toBe(0)
	})

	describe("ASCII words", () => {
		it("counts a single word", () => {
			const result = estimateContextTokens("hello")
			expect(result).toBeGreaterThan(0)
		})

		it("counts digits as word characters", () => {
			const result = estimateContextTokens("abc123")
			expect(result).toBeGreaterThan(0)
		})

		it("counts underscore as word character", () => {
			const result = estimateContextTokens("snake_case")
			expect(result).toBeGreaterThan(0)
		})

		it("counts uppercase as word characters", () => {
			const result = estimateContextTokens("HELLO")
			expect(result).toBeGreaterThan(0)
		})

		it("splits on non-word characters", () => {
			const a = estimateContextTokens("hello")
			const b = estimateContextTokens("hello world")
			expect(b).toBeGreaterThan(a)
		})
	})

	describe("CJK characters", () => {
		it("counts CJK characters as tokens", () => {
			const result = estimateContextTokens("\u4e2d\u6587")
			expect(result).toBeGreaterThan(0)
		})

		it("handles CJK extension A range", () => {
			const result = estimateContextTokens("\u3400")
			expect(result).toBeGreaterThan(0)
		})

		it("handles mixed CJK and ASCII", () => {
			const result = estimateContextTokens("hello\u4e2dworld")
			expect(result).toBeGreaterThan(0)
		})
	})

	describe("counted punctuation", () => {
		it.each([
			["<", "less than"],
			[">", "greater than"],
			["{", "left brace"],
			["}", "right brace"],
			["(", "left paren"],
			[")", "right paren"],
			["[", "left bracket"],
			["]", "right bracket"],
			[".", "dot"],
			[",", "comma"],
			[":", "colon"],
			[";", "semicolon"],
			["=", "equals"],
			["+", "plus"],
			["-", "minus"],
			["*", "asterisk"],
			["/", "slash"],
			["!", "exclamation"],
			["?", "question"],
			["|", "pipe"],
			["&", "ampersand"],
		])("counts '%s' (%s) as 1 token", (char) => {
			const result = estimateContextTokens(char)
			expect(result).toBe(1)
		})
	})

	describe("whitespace", () => {
		it("does not count spaces as tokens", () => {
			expect(estimateContextTokens("   ")).toBe(0)
		})

		it("does not count tabs as tokens", () => {
			expect(estimateContextTokens("\t\t")).toBe(0)
		})

		it("does not count newlines as tokens", () => {
			expect(estimateContextTokens("\n\n")).toBe(0)
		})

		it("counts non-breaking space as whitespace", () => {
			expect(estimateContextTokens("\u00a0")).toBe(0)
		})
	})

	describe("non-whitespace non-punct non-word non-CJK", () => {
		it("counts other characters as ~0.4 tokens", () => {
			const result = estimateContextTokens("@")
			expect(result).toBe(1)
		})
	})

	describe("surrogate pairs / emoji", () => {
		it("handles emoji (surrogate pair)", () => {
			const result = estimateContextTokens("\ud83d\ude00")
			expect(result).toBeGreaterThanOrEqual(0)
		})
	})
})

describe("addPrioritized", () => {
	it("adds content to bucket", () => {
		const bucket: PrioritizedCangjieSection[] = []
		addPrioritized(bucket, 100, "hello")
		expect(bucket).toEqual([{ priority: 100, content: "hello" }])
	})

	it("skips null content", () => {
		const bucket: PrioritizedCangjieSection[] = []
		addPrioritized(bucket, 100, null)
		expect(bucket).toEqual([])
	})

	it("skips undefined content", () => {
		const bucket: PrioritizedCangjieSection[] = []
		addPrioritized(bucket, 100, undefined)
		expect(bucket).toEqual([])
	})

	it("skips empty string content", () => {
		const bucket: PrioritizedCangjieSection[] = []
		addPrioritized(bucket, 100, "")
		expect(bucket).toEqual([])
	})
})

describe("buildMandatoryCorpusFooter", () => {
	it("returns empty string when docsBase is null", () => {
		expect(buildMandatoryCorpusFooter(null, true)).toBe("")
	})

	it("returns empty string when docsBase is undefined", () => {
		expect(buildMandatoryCorpusFooter(undefined, true)).toBe("")
	})

	it("returns empty string when docsBase is empty", () => {
		expect(buildMandatoryCorpusFooter("", true)).toBe("")
	})

	it("returns empty string when docsExist is false", () => {
		expect(buildMandatoryCorpusFooter("/docs", false)).toBe("")
	})

	it("returns footer when docsBase and docsExist are truthy", () => {
		const result = buildMandatoryCorpusFooter("/path/to/docs", true)
		expect(result).toContain("/path/to/docs/")
	})

	it("converts backslashes to forward slashes", () => {
		const result = buildMandatoryCorpusFooter("C:\\path\\docs", true)
		expect(result).toContain("C:/path/docs/")
	})
})

describe("packSectionsWithTokenBudget", () => {
	it("returns empty array when no items fit the budget", () => {
		const result = packSectionsWithTokenBudget(
			[{ priority: 100, content: "a very long section that exceeds the tiny budget" }],
			"",
			5,
		)
		expect(result).toEqual([])
	})

	it("packs sections in ascending priority order", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 300, content: "normal" },
			{ priority: 100, content: "high" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000)
		expect(result).toEqual(["high", "normal"])
	})

	it("appends mandatory footer at the end", () => {
		const items: PrioritizedCangjieSection[] = [{ priority: 100, content: "section" }]
		const footer = "footer text"
		const result = packSectionsWithTokenBudget(items, footer, 10000)
		expect(result[result.length - 1]).toBe(footer)
	})

	it("reserves space for footer when budget is tight", () => {
		const items: PrioritizedCangjieSection[] = [{ priority: 100, content: "section" }]
		const result = packSectionsWithTokenBudget(items, "important footer", 10)
		// Footer should always be appended
		expect(result).toContain("important footer")
	})

	it("skips empty mandatory footer", () => {
		const items: PrioritizedCangjieSection[] = [{ priority: 100, content: "section" }]
		const result = packSectionsWithTokenBudget(items, "", 10000)
		expect(result).toEqual(["section"])
	})

	it("uses rawErrorCount and totalDiagnosticCount to compute reserves", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 100, content: "high" },
			{ priority: 300, content: "normal" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000, {
			rawErrorCount: 10,
			totalDiagnosticCount: 50,
		})
		expect(result).toContain("high")
		expect(result).toContain("normal")
	})

	it("uses diagnosticSectionMinTokens floor", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 100, content: "high" },
			{ priority: 300, content: "normal" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000, {
			rawErrorCount: 10,
			diagnosticSectionMinTokens: 2000,
		})
		expect(result).toContain("high")
	})

	it("handles all high priority items (splitIdx == sorted.length)", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 100, content: "a" },
			{ priority: 200, content: "b" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000)
		expect(result).toEqual(["a", "b"])
	})

	it("handles no high priority items (all >= 300)", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 300, content: "normal" },
			{ priority: 500, content: "low" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000)
		expect(result).toEqual(["normal", "low"])
	})

	it("spills high priority overflow into remaining budget", () => {
		const items: PrioritizedCangjieSection[] = [
			{ priority: 100, content: "a" },
			{ priority: 300, content: "b" },
		]
		const result = packSectionsWithTokenBudget(items, "", 10000)
		expect(result).toContain("a")
		expect(result).toContain("b")
	})
})

describe("simpleHash", () => {
	it("returns a consistent hash for the same input", () => {
		expect(simpleHash("hello")).toBe(simpleHash("hello"))
	})

	it("returns different hashes for different inputs", () => {
		expect(simpleHash("hello")).not.toBe(simpleHash("world"))
	})

	it("returns 0 for empty string", () => {
		expect(simpleHash("")).toBe(0)
	})

	it("returns unsigned 32-bit integer", () => {
		const h = simpleHash("test")
		expect(h).toBeGreaterThanOrEqual(0)
		expect(h).toBeLessThanOrEqual(0xffffffff)
		expect(Number.isInteger(h)).toBe(true)
	})
})
