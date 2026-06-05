import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	listFilesMock,
	formatFilesListMock,
	isPathOutsideWorkspaceMock,
	isPathUnderBundledCangjieCorpusMock,
	isPathPotentiallyUnderCangjieCorpusMock,
	toolResultCacheGetMock,
	toolResultCacheSetMock,
	toolResultCacheMakeKeyMock,
} = vi.hoisted(() => ({
	listFilesMock: vi.fn(),
	formatFilesListMock: vi.fn(),
	isPathOutsideWorkspaceMock: vi.fn(),
	isPathUnderBundledCangjieCorpusMock: vi.fn(),
	isPathPotentiallyUnderCangjieCorpusMock: vi.fn(),
	toolResultCacheGetMock: vi.fn(),
	toolResultCacheSetMock: vi.fn(),
	toolResultCacheMakeKeyMock: vi.fn().mockReturnValue("cache-key"),
}))

vi.mock("../../../services/glob/list-files", () => ({
	listFiles: listFilesMock,
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		formatFilesList: formatFilesListMock,
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
	},
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: isPathOutsideWorkspaceMock,
}))

vi.mock("../../../utils/bundledCangjieCorpus", () => ({
	isPathUnderBundledCangjieCorpus: isPathUnderBundledCangjieCorpusMock,
	isPathPotentiallyUnderCangjieCorpus: isPathPotentiallyUnderCangjieCorpusMock,
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn((_cwd: string, rel: string) => rel),
}))

vi.mock("../helpers/ToolResultCache", () => ({
	toolResultCache: {
		get: toolResultCacheGetMock,
		set: toolResultCacheSetMock,
		makeKey: toolResultCacheMakeKeyMock,
	},
}))

import { listFilesTool } from "../ListFilesTool"

function createTask(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/workspace",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		rooIgnoreController: {},
		rooProtectedController: {},
		providerRef: {
			deref: () => ({
				context: { extensionPath: "/ext" },
				getState: vi.fn().mockResolvedValue({ showRooIgnoredFiles: false }),
			}),
		},
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

describe("ListFilesTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		listFilesMock.mockResolvedValue([["src/index.ts"], false])
		formatFilesListMock.mockResolvedValue("src/index.ts")
		isPathOutsideWorkspaceMock.mockReturnValue(false)
		isPathUnderBundledCangjieCorpusMock.mockReturnValue(false)
		isPathPotentiallyUnderCangjieCorpusMock.mockReturnValue(false)
		toolResultCacheGetMock.mockReturnValue(undefined)
	})

	describe("metadata", () => {
		it("is concurrency safe", () => {
			expect(listFilesTool.isConcurrencySafe()).toBe(true)
		})

		it("is eager execution", () => {
			expect(listFilesTool.getEagerExecutionDecision()).toBe("eager")
		})

		it("has stable partial args when path is a string", () => {
			expect(listFilesTool.isPartialArgsStable({ path: "src" })).toBe(true)
			expect(listFilesTool.isPartialArgsStable({ path: "" })).toBe(true)
			expect(listFilesTool.isPartialArgsStable({})).toBe(false)
		})
	})

	describe("execute", () => {
		it("returns cached result if available", async () => {
			toolResultCacheGetMock.mockReturnValue("cached file list")
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "src" }, createTask(), callbacks as any)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("cached file list")
			expect(listFilesMock).not.toHaveBeenCalled()
		})

		it("lists files non-recursively and asks approval", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "src" }, task, callbacks as any)

			expect(listFilesMock).toHaveBeenCalledWith(expect.stringContaining("src"), false, 200)
			expect(formatFilesListMock).toHaveBeenCalled()
			expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesTopLevel"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("src/index.ts")
			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("lists files recursively", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "src", recursive: true }, task, callbacks as any)

			expect(listFilesMock).toHaveBeenCalledWith(expect.stringContaining("src"), true, 200)
			expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesRecursive"))
		})

		it("defaults path to . when empty", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "" }, task, callbacks as any)

			expect(listFilesMock).toHaveBeenCalled()
		})

		it("returns results without approval for cangjie corpus paths", async () => {
			isPathUnderBundledCangjieCorpusMock.mockReturnValue(true)
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "corpus" }, createTask(), callbacks as any)

			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("src/index.ts")
		})

		it("does not push result when approval is denied", async () => {
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValue(false)

			await listFilesTool.execute({ path: "src" }, createTask(), callbacks as any)

			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		})

		it("detects outside workspace paths", async () => {
			isPathOutsideWorkspaceMock.mockReturnValue(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "/outside" }, task, callbacks as any)

			expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("true"))
		})

		it("delegates errors to handleError", async () => {
			listFilesMock.mockRejectedValue(new Error("glob failed"))
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "src" }, createTask(), callbacks as any)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"listing files",
				expect.objectContaining({ message: "glob failed" }),
			)
		})

		it("wraps non-Error throws", async () => {
			listFilesMock.mockRejectedValue("string error")
			const callbacks = createCallbacks()

			await listFilesTool.execute({ path: "src" }, createTask(), callbacks as any)

			expect(callbacks.handleError).toHaveBeenCalledWith("listing files", expect.any(Error))
		})
	})

	describe("handlePartial", () => {
		it("asks with partial tool message", async () => {
			const task = createTask()

			await listFilesTool.handlePartial(task, {
				params: { path: "src", recursive: "true" },
				partial: true,
			} as any)

			expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("listFilesRecursive"), true)
		})

		it("suppresses partial output for cangjie corpus paths", async () => {
			isPathPotentiallyUnderCangjieCorpusMock.mockReturnValue(true)
			const task = createTask()

			await listFilesTool.handlePartial(task, {
				params: { path: "corpus" },
				partial: true,
			} as any)

			expect(task.ask).not.toHaveBeenCalled()
		})
	})
})
