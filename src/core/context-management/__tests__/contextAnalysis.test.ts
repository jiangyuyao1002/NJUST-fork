import { describe, it, expect } from "vitest"

import { analyzeContextTokens, formatAnalysisResult, LARGE_RESULT_THRESHOLD } from "../contextAnalysis"

function makeMsg(role: string, content: any, opts?: { isSummary?: boolean }): any {
	return { role, content, isSummary: opts?.isSummary ?? false }
}

describe("analyzeContextTokens", () => {
	it("returns zero breakdown for empty messages", () => {
		const r = analyzeContextTokens([], 100)
		expect(r.breakdown.systemPromptTokens).toBe(100)
		expect(r.breakdown.totalTokens).toBe(100)
		expect(r.totalMessageCount).toBe(0)
	})

	it("defaults systemPromptTokens to 0", () => {
		const r = analyzeContextTokens([])
		expect(r.breakdown.systemPromptTokens).toBe(0)
	})

	it("categorizes user text messages", () => {
		const r = analyzeContextTokens([makeMsg("user", "hello world")])
		expect(r.breakdown.userMessageTokens).toBeGreaterThan(0)
	})

	it("categorizes assistant text messages", () => {
		const r = analyzeContextTokens([makeMsg("assistant", "response here")])
		expect(r.breakdown.assistantTextTokens).toBeGreaterThan(0)
	})

	it("categorizes other role text messages", () => {
		const r = analyzeContextTokens([makeMsg("system", "system msg")])
		expect(r.totalMessageCount).toBe(1)
	})

	it("handles summary messages", () => {
		const r = analyzeContextTokens([makeMsg("user", "summary text", { isSummary: true })])
		expect(r.summaryMessageCount).toBe(1)
		expect(r.breakdown.summaryTokens).toBeGreaterThan(0)
	})

	it("categorizes tool_result blocks", () => {
		const content = [{ type: "tool_result", tool_use_id: "t1", content: "result text" }]
		const r = analyzeContextTokens([makeMsg("user", content)])
		expect(r.breakdown.toolResultTokens).toBeGreaterThan(0)
	})

	it("categorizes tool_use blocks", () => {
		const content = [{ type: "tool_use", id: "t1", name: "read_file", input: {} }]
		const r = analyzeContextTokens([makeMsg("assistant", content)])
		expect(r.breakdown.toolUseTokens).toBeGreaterThan(0)
	})

	it("categorizes text blocks by role", () => {
		const content = [{ type: "text", text: "hello" }]
		const r1 = analyzeContextTokens([makeMsg("user", content)])
		expect(r1.breakdown.userMessageTokens).toBeGreaterThan(0)

		const r2 = analyzeContextTokens([makeMsg("assistant", content)])
		expect(r2.breakdown.assistantTextTokens).toBeGreaterThan(0)

		const r3 = analyzeContextTokens([makeMsg("system", content)])
		expect(r3.breakdown.otherTokens).toBeGreaterThan(0)
	})

	it("flags large tool results", () => {
		const bigText = "x".repeat(LARGE_RESULT_THRESHOLD * 4 + 100)
		const toolUse = [{ type: "tool_use", id: "t1", name: "read_file", input: {} }]
		const toolResult = [{ type: "tool_result", tool_use_id: "t1", content: bigText }]
		const msgs = [makeMsg("assistant", toolUse), makeMsg("user", toolResult)]
		const r = analyzeContextTokens(msgs)
		expect(r.largeToolResults.length).toBeGreaterThanOrEqual(1)
	})

	it("detects duplicate file reads", () => {
		const toolUse = [{ type: "tool_use", id: "t1", name: "read_file", input: {} }]
		const toolResult = [
			{ type: "tool_result", tool_use_id: "t1", content: "File: /path/to/file.ts\ncontents here" },
		]
		const msgs = [
			makeMsg("assistant", toolUse),
			makeMsg("user", toolResult),
			makeMsg("assistant", toolUse),
			makeMsg("user", toolResult),
		]
		const r = analyzeContextTokens(msgs)
		expect(r.duplicateReads.length).toBeGreaterThanOrEqual(1)
		expect(r.estimatedDuplicateReadTokens).toBeGreaterThan(0)
	})

	it("handles non-array content", () => {
		const r = analyzeContextTokens([makeMsg("user", null)])
		expect(r.totalMessageCount).toBe(1)
	})

	it("handles unknown block types", () => {
		const content = [{ type: "unknown_type", data: "value" }]
		const r = analyzeContextTokens([makeMsg("user", content)])
		expect(r.totalMessageCount).toBe(1)
	})
})

describe("formatAnalysisResult", () => {
	it("formats a complete analysis result", () => {
		const analysis = analyzeContextTokens([makeMsg("user", "hello")], 100)
		const formatted = formatAnalysisResult(analysis)
		expect(formatted).toContain("Token Breakdown")
		expect(formatted).toContain("System prompt")
		expect(formatted).toContain("Tool results")
	})

	it("shows duplicate reads when present", () => {
		const toolUse = [{ type: "tool_use", id: "t1", name: "read_file", input: {} }]
		const toolResult = [{ type: "tool_result", tool_use_id: "t1", content: "File: /f.ts\ndata" }]
		const msgs = [
			makeMsg("assistant", toolUse),
			makeMsg("user", toolResult),
			makeMsg("assistant", toolUse),
			makeMsg("user", toolResult),
		]
		const analysis = analyzeContextTokens(msgs)
		const formatted = formatAnalysisResult(analysis)
		if (analysis.duplicateReads.length > 0) {
			expect(formatted).toContain("Duplicate")
		}
	})
})
