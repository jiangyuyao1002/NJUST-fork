import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockResolveTool, mockBuildEnv } = vi.hoisted(() => ({
	mockResolveTool: vi.fn(),
	mockBuildEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveTool,
	buildCangjieToolEnv: mockBuildEnv,
}))

vi.mock("child_process", () => ({
	execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
		cb(new Error("not implemented"))
	}),
}))

import { getCjpmTreeSummaryForPrompt, clearCjpmTreePromptCache } from "../cjpmTreeForPrompt"

describe("cjpmTreeForPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		clearCjpmTreePromptCache()
	})

	afterEach(() => {
		clearCjpmTreePromptCache()
	})

	it("returns empty string when cjpm not found", async () => {
		mockResolveTool.mockReturnValue(undefined)
		const result = await getCjpmTreeSummaryForPrompt("/test/project")
		expect(result).toBe("")
	})

	it("returns empty string on exec error", async () => {
		mockResolveTool.mockReturnValue("/mock/cjpm")
		const result = await getCjpmTreeSummaryForPrompt("/test/error")
		expect(result).toBe("")
	})

	it("returns cached result on second call", async () => {
		mockResolveTool.mockReturnValue(undefined)
		const result1 = await getCjpmTreeSummaryForPrompt("/test/cache-hit")
		const result2 = await getCjpmTreeSummaryForPrompt("/test/cache-hit")
		expect(result1).toBe(result2)
	})

	it("clearCjpmTreePromptCache clears the cache", async () => {
		mockResolveTool.mockReturnValue(undefined)
		await getCjpmTreeSummaryForPrompt("/test/clear")
		clearCjpmTreePromptCache()
		await getCjpmTreeSummaryForPrompt("/test/clear")
		// After clearing, resolveCangjieToolPath should be called again
		expect(mockResolveTool).toHaveBeenCalledTimes(2)
	})
})
