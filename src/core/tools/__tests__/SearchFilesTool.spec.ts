import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	regexSearchFilesMock,
	isPathUnderBundledCangjieCorpusMock,
	isPathPotentiallyUnderCangjieCorpusMock,
	getBundledCangjieCorpusPathMock,
	semanticAvailableMock,
	semanticSearchMock,
	semanticFingerprintMock,
	expandSemanticQueryMock,
} = vi.hoisted(() => ({
	regexSearchFilesMock: vi.fn(),
	isPathUnderBundledCangjieCorpusMock: vi.fn(),
	isPathPotentiallyUnderCangjieCorpusMock: vi.fn(),
	getBundledCangjieCorpusPathMock: vi.fn(),
	semanticAvailableMock: vi.fn(),
	semanticSearchMock: vi.fn(),
	semanticFingerprintMock: vi.fn(),
	expandSemanticQueryMock: vi.fn(),
}))

vi.mock("../../../services/ripgrep", () => ({
	regexSearchFiles: regexSearchFilesMock,
}))

vi.mock("../../../utils/bundledCangjieCorpus", () => ({
	isPathUnderBundledCangjieCorpus: isPathUnderBundledCangjieCorpusMock,
	isPathPotentiallyUnderCangjieCorpus: isPathPotentiallyUnderCangjieCorpusMock,
	getBundledCangjieCorpusPath: getBundledCangjieCorpusPathMock,
}))

vi.mock("../../../services/cangjie-corpus/CangjieCorpusSemanticIndex", () => ({
	CangjieCorpusSemanticIndex: vi.fn(function () {
		return {
			get isAvailable() {
				return semanticAvailableMock()
			},

			search: semanticSearchMock,
		}
	}),
	expandCangjieSemanticQuery: expandSemanticQueryMock,
	getCangjieSemanticIndexFingerprint: semanticFingerprintMock,
}))

import { SearchFilesTool } from "../SearchFilesTool"

function createTask(overrides: Record<string, unknown> = {}) {
	const runtimePolicy = { noteCorpusSearch: vi.fn() }
	return {
		cwd: "D:\\repo",
		providerRef: { deref: () => ({ context: { extensionPath: "D:\\ext" } }) },
		rooIgnoreController: { validateAccess: vi.fn() },
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing regex"),
		taskMode: "default",
		cangjieSearchHistory: new Set<string>(),
		cangjieRuntimePolicy: runtimePolicy,
		ask: vi.fn().mockResolvedValue(true),
		...overrides,
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	}
}

describe("SearchFilesTool", () => {
	let tool: SearchFilesTool

	beforeEach(() => {
		vi.clearAllMocks()
		tool = new SearchFilesTool()
		regexSearchFilesMock.mockResolvedValue("regex matches")
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(false)
		isPathPotentiallyUnderCangjieCorpusMock.mockReturnValue(false)
		getBundledCangjieCorpusPathMock.mockReturnValue("D:\\ext\\bundled-cangjie-corpus\\CangjieCorpus-1.0.0")
		semanticAvailableMock.mockReturnValue(true)
		semanticSearchMock.mockReturnValue([])
		semanticFingerprintMock.mockReturnValue(`fp-${Date.now()}-${Math.random()}`)
		expandSemanticQueryMock.mockImplementation((query: string) => `${query} expanded`)
	})

	it("exposes eager concurrency metadata", () => {
		expect(tool.isConcurrencySafe()).toBe(true)
		expect(tool.getEagerExecutionDecision()).toBe("eager")
		expect(tool.isPartialArgsStable({ path: ".", regex: "main" })).toBe(true)
		expect(tool.isPartialArgsStable({ path: "." })).toBe(false)
	})

	it("rejects empty regex during validation", () => {
		expect(tool.validateInput({ path: ".", regex: "" }).valid).toBe(false)
		expect(tool.validateInput({ path: ".", regex: "   " }).error).toContain("required")
	})

	it("rejects invalid regex during validation", () => {
		const result = tool.validateInput({ path: ".", regex: "[" })
		expect(result.valid).toBe(false)
		expect(result.error).toContain("Invalid regex")
	})

	it("rejects empty path during validation", () => {
		const result = tool.validateInput({ path: " ", regex: "main" })
		expect(result.valid).toBe(false)
		expect(result.error).toContain("Search path")
	})

	it("records a tool mistake when execute receives no regex or semantic query", async () => {
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ path: ".", regex: undefined as any }, task, callbacks as any)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("search_files")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("missing regex")
	})

	it("runs regex search and asks approval for workspace results", async () => {
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ path: "src", regex: "main", file_pattern: "*.ts" }, task, callbacks as any)

		expect(regexSearchFilesMock).toHaveBeenCalledWith(
			task.cwd,
			expect.stringContaining("src"),
			"main",
			"*.ts",
			task.rooIgnoreController,
		)
		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("regex matches"))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("regex matches")
	})

	it("does not push regex results when approval is denied", async () => {
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValueOnce(false)

		await tool.execute({ path: "src", regex: "denied" }, createTask(), callbacks as any)

		expect(regexSearchFilesMock).toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("delegates regex search failures to handleError", async () => {
		regexSearchFilesMock.mockRejectedValueOnce(new Error("ripgrep failed"))
		const callbacks = createCallbacks()

		await tool.execute({ path: "src", regex: "boom" }, createTask(), callbacks as any)

		expect(callbacks.handleError).toHaveBeenCalledWith(
			"searching files",
			expect.objectContaining({ message: "ripgrep failed" }),
		)
	})

	it("returns and caches cangjie corpus regex results without approval", async () => {
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(true)
		const task = createTask({ taskMode: "cangjie" })
		const callbacks = createCallbacks()
		const params = { path: "corpus-cache", regex: "std.fs" }

		await tool.execute(params, task, callbacks as any)
		regexSearchFilesMock.mockClear()
		await tool.execute(params, task, callbacks as any)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(regexSearchFilesMock).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenLastCalledWith("regex matches")
		expect(task.cangjieSearchHistory.has("std.fs")).toBe(true)
		expect(task.cangjieRuntimePolicy.noteCorpusSearch).toHaveBeenCalledWith(["std.fs"], "std.fs")
	})

	it("formats semantic corpus hits and skips approval", async () => {
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(true)
		semanticSearchMock.mockReturnValueOnce([
			{ relPath: "libs/std/fs/file.cj", startLine: 4, score: 2.5, heading: "File", snippet: "open file" },
		])
		const callbacks = createCallbacks()

		await tool.execute(
			{ path: ".", regex: "std.fs", semantic_query: "std.fs open" },
			createTask({ taskMode: "cangjie" }),
			callbacks as any,
		)

		const output = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(output).toContain('Semantic search results for: "std.fs open"')
		expect(output).toContain("libs/std/fs/file.cj")
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("expands semantic query when the first search has no hits", async () => {
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(true)
		semanticSearchMock
			.mockReturnValueOnce([])
			.mockReturnValueOnce([
				{ relPath: "libs/std/net/http.cj", startLine: 0, score: 1.1, heading: "HTTP", snippet: "request" },
			])

		await tool.execute(
			{ path: ".", regex: "std.net", semantic_query: "http" },
			createTask(),
			createCallbacks() as any,
		)

		expect(expandSemanticQueryMock).toHaveBeenCalledWith("http")
		expect(semanticSearchMock).toHaveBeenNthCalledWith(2, "http expanded", 10, expect.anything())
	})

	it("falls back to regex when semantic index is unavailable", async () => {
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(true)
		semanticAvailableMock.mockReturnValue(false)
		const callbacks = createCallbacks()

		await tool.execute(
			{ path: ".", regex: "fallback", semantic_query: "not indexed" },
			createTask(),
			callbacks as any,
		)

		expect(regexSearchFilesMock).toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("regex matches")
	})

	it("shows partial search state outside cangjie corpus", async () => {
		const task = createTask()

		await tool.handlePartial(task, {
			params: { path: "src", regex: "main", file_pattern: "*.ts" },
			partial: true,
		} as any)

		expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining('"content":""'), true)
	})

	it("suppresses partial output while path may still become cangjie corpus", async () => {
		isPathPotentiallyUnderCangjieCorpusMock.mockReturnValue(true)
		const task = createTask()

		await tool.handlePartial(task, {
			params: { path: "D:\\ext\\bundled", regex: "std.fs" },
			partial: true,
		} as any)

		expect(task.ask).not.toHaveBeenCalled()
	})
})
