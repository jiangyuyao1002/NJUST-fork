import { describe, it, expect } from "vitest"

import {
	analyzeCompileOutput,
	getErrorFixDirective,
	getFixDirectiveForLearning,
	normalizeErrorPattern,
	formatAnalysisSummary,
	patternPriority,
	STDLIB_DOC_MAP,
} from "../CangjieErrorAnalyzer"

describe("CangjieErrorAnalyzer - analysis functions", () => {
	describe("analyzeCompileOutput", () => {
		it("returns empty array for no matching patterns", () => {
			const result = analyzeCompileOutput("everything compiled successfully", [])
			expect(result).toEqual([])
		})

		it("returns analysis for matching error pattern", () => {
			const result = analyzeCompileOutput("incompatible types: String cannot be assigned to Int64", [
				{ file: "main.cj", line: 10, col: 5 },
			])
			expect(result.length).toBeGreaterThan(0)
			expect(result[0].category).toBe("类型不匹配")
			expect(result[0].errorKeys).toEqual(["main.cj:10"])
		})

		it("includes std library docs when std packages in output", () => {
			const result = analyzeCompileOutput("error in std.collection: incompatible types", [
				{ file: "main.cj", line: 1, col: 1 },
			])
			expect(result.length).toBeGreaterThan(0)
		})

		it("prepends docsBase to doc paths", () => {
			const result = analyzeCompileOutput(
				"incompatible types: String cannot be assigned to Int64",
				[{ file: "main.cj", line: 1, col: 1 }],
				"/docs/base",
			)
			expect(result.length).toBeGreaterThan(0)
			expect(result[0].docHints.relPaths.some((p) => p.startsWith("/docs/base"))).toBe(true)
		})
	})

	describe("getErrorFixDirective", () => {
		it("returns fix directive for unused variables", () => {
			const result = getErrorFixDirective("unused variable x")
			expect(result).toContain("移除未使用")
		})

		it("returns fix directive for matching pattern", () => {
			const result = getErrorFixDirective("incompatible types: String cannot be assigned to Int64")
			expect(result).toContain("类型")
		})

		it("returns generic directive for unknown errors", () => {
			const result = getErrorFixDirective("some completely unknown error xyz")
			expect(result).toContain("grep_search")
		})
	})

	describe("getFixDirectiveForLearning", () => {
		it("returns clean directive for unused variables", () => {
			const result = getFixDirectiveForLearning("unused import foo")
			expect(result).toBe("移除未使用的变量/导入/参数")
		})

		it("returns clean directive for matching pattern", () => {
			const result = getFixDirectiveForLearning("incompatible types: String cannot be assigned to Int64")
			expect(result).toBeDefined()
			expect(result).not.toContain("切记")
		})

		it("returns null for unknown errors", () => {
			const result = getFixDirectiveForLearning("some completely unknown error xyz")
			expect(result).toBeNull()
		})
	})

	describe("normalizeErrorPattern", () => {
		it("strips ANSI escape codes", () => {
			const result = normalizeErrorPattern("\x1b[31merror\x1b[0m: something")
			expect(result).not.toContain("\x1b")
		})

		it("strips file location prefixes", () => {
			const result = normalizeErrorPattern("==> main.cj:10:5: type mismatch")
			expect(result).not.toContain("==>")
		})

		it("collapses whitespace", () => {
			const result = normalizeErrorPattern("  error   with   spaces  ")
			expect(result).not.toMatch(/\s{2,}/)
		})

		it("prefixes with matched category", () => {
			const result = normalizeErrorPattern("incompatible types: String cannot be assigned to Int64")
			expect(result).toContain("[类型不匹配]")
		})

		it("truncates long messages to 200 chars", () => {
			const longError = "x".repeat(300)
			const result = normalizeErrorPattern(longError)
			expect(result.length).toBeLessThanOrEqual(200)
		})
	})

	describe("formatAnalysisSummary", () => {
		it("returns empty string for no analyses", () => {
			expect(formatAnalysisSummary([])).toBe("")
		})

		it("formats single analysis", () => {
			const analyses = analyzeCompileOutput("incompatible types: String cannot be assigned to Int64", [
				{ file: "main.cj", line: 1, col: 1 },
			])
			const result = formatAnalysisSummary(analyses)
			expect(result).toContain("[ErrorAnalyzer]")
			expect(result).toContain("类型不匹配")
		})

		it("limits doc paths to 3", () => {
			const analyses = [
				{
					category: "test",
					docHints: { relPaths: ["alpha", "beta", "gamma", "delta", "epsilon"], rationale: "test" },
					suggestion: "test suggestion",
					errorKeys: [],
				},
			]
			const result = formatAnalysisSummary(analyses)
			expect(result).toContain("alpha, beta, gamma")
			expect(result).not.toContain("delta")
			expect(result).not.toContain("epsilon")
		})
	})

	describe("patternPriority", () => {
		it("returns 0 for patterns without explicit priority", () => {
			const p = { pattern: /test/, category: "test", docPaths: [], suggestion: "test" }
			expect(patternPriority(p)).toBe(0)
		})

		it("returns explicit priority", () => {
			const p = { pattern: /test/, category: "test", docPaths: [], suggestion: "test", priority: 10 }
			expect(patternPriority(p)).toBe(10)
		})
	})

	describe("STDLIB_DOC_MAP", () => {
		it("contains expected std library prefixes", () => {
			const prefixes = STDLIB_DOC_MAP.map((m) => m.prefix)
			expect(prefixes).toContain("std.collection")
			expect(prefixes).toContain("std.io")
			expect(prefixes).toContain("std.sync")
		})
	})
})
