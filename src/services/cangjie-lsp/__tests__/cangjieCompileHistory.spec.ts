import { describe, it, expect, beforeEach } from "vitest"

import {
	recordCompileHistoryEvent,
	formatCompileHistoryPromptSection,
	getCompileHistoryRevision,
} from "../cangjieCompileHistory"

describe("cangjieCompileHistory", () => {
	beforeEach(() => {
		// Reset state by recording events for a unique cwd to avoid pollution
		// The module uses global maps; we test with unique cwds per describe block
	})

	describe("getCompileHistoryRevision", () => {
		it("returns 0 for unknown cwd", () => {
			expect(getCompileHistoryRevision("/unknown/cwd")).toBe(0)
		})

		it("increments revision after recording event", () => {
			const testCwd = `/test/rev-${Date.now()}`
			expect(getCompileHistoryRevision(testCwd)).toBe(0)
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: true,
				incremental: false,
				durationMs: 100,
				errorCount: 0,
				errors: [],
			})
			expect(getCompileHistoryRevision(testCwd)).toBe(1)
		})
	})

	describe("recordCompileHistoryEvent", () => {
		it("records successful build", () => {
			const testCwd = `/test/success-${Date.now()}`
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: true,
				incremental: true,
				durationMs: 500,
				errorCount: 0,
				errors: [],
			})
			const section = formatCompileHistoryPromptSection(testCwd)
			expect(section).toContain("✅ 通过")
			expect(section).toContain("增量")
		})

		it("records failed build with errors", () => {
			const testCwd = `/test/fail-${Date.now()}`
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: false,
				incremental: false,
				durationMs: 1200,
				errorCount: 2,
				errors: [
					{ file: "main.cj", line: 10, message: "type mismatch: expected Int64, found String" },
					{ file: "utils.cj", line: 5, message: "undeclared identifier: foo" },
				],
			})
			const section = formatCompileHistoryPromptSection(testCwd)
			expect(section).toContain("❌ 失败")
			expect(section).toContain("2 条")
			expect(section).toContain("全量")
			expect(section).toContain("main.cj:10")
		})

		it("limits entries to 5 per cwd", () => {
			const testCwd = `/test/limit-${Date.now()}`
			for (let i = 0; i < 7; i++) {
				recordCompileHistoryEvent({
					cwd: testCwd,
					success: true,
					incremental: false,
					durationMs: 100,
					errorCount: 0,
					errors: [],
				})
			}
			// After 7 records, only last 5 remain — revision should be 7
			expect(getCompileHistoryRevision(testCwd)).toBe(7)
		})

		it("generates fingerprints for error messages", () => {
			const testCwd = `/test/fp-${Date.now()}`
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: false,
				incremental: false,
				durationMs: 100,
				errorCount: 1,
				errors: [{ file: "-", line: 0, message: "some error" }],
			})
			const section = formatCompileHistoryPromptSection(testCwd)
			// fingerprint is 8-char hex
			expect(section).toMatch(/[0-9a-f]{8}/)
		})
	})

	describe("formatCompileHistoryPromptSection", () => {
		it("returns null for unknown cwd", () => {
			expect(formatCompileHistoryPromptSection("/unknown/cwd/null")).toBeNull()
		})

		it("includes header and description", () => {
			const testCwd = `/test/header-${Date.now()}`
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: true,
				incremental: false,
				durationMs: 100,
				errorCount: 0,
				errors: [],
			})
			const section = formatCompileHistoryPromptSection(testCwd)
			expect(section).toContain("## 本轮编译历史")
			expect(section).toContain("最近若干次")
		})

		it("truncates error display to 4 errors", () => {
			const testCwd = `/test/trunc-${Date.now()}`
			const errors = Array.from({ length: 6 }, (_, i) => ({
				file: `file${i}.cj`,
				line: i,
				message: `error ${i}`,
			}))
			recordCompileHistoryEvent({
				cwd: testCwd,
				success: false,
				incremental: false,
				durationMs: 100,
				errorCount: 6,
				errors,
			})
			const section = formatCompileHistoryPromptSection(testCwd)!
			expect(section).toContain("… 另有 2 条")
		})
	})
})
