import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "fs/promises"

// Hoist mocks
const {
	allowRooIgnorePathAccessMock,
	isPathOutsideWorkspaceMock,
	fileExistsAtPathMock,
	unescapeHtmlEntitiesMock,
	experimentsIsEnabledMock,
	computeDiffStatsMock,
	sanitizeUnifiedDiffMock,
} = vi.hoisted(() => ({
	allowRooIgnorePathAccessMock: vi.fn(),
	isPathOutsideWorkspaceMock: vi.fn(),
	fileExistsAtPathMock: vi.fn(),
	unescapeHtmlEntitiesMock: vi.fn(),
	experimentsIsEnabledMock: vi.fn(),
	computeDiffStatsMock: vi.fn(),
	sanitizeUnifiedDiffMock: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
	},
}))

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	RelativePattern: vi.fn(),
}))

// Correct relative mock paths following the vitest path trap rule:
vi.mock("../../ignore/RooIgnoreController", () => ({
	allowRooIgnorePathAccess: allowRooIgnorePathAccessMock,
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: isPathOutsideWorkspaceMock,
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: fileExistsAtPathMock,
}))

vi.mock("../../../utils/text-normalization", () => ({
	unescapeHtmlEntities: unescapeHtmlEntitiesMock,
}))

vi.mock("../../../shared/experiments", () => ({
	EXPERIMENT_IDS: {
		PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	},
	experiments: {
		isEnabled: experimentsIsEnabledMock,
	},
}))

vi.mock("../../diff/stats", () => ({
	computeDiffStats: computeDiffStatsMock,
	sanitizeUnifiedDiff: sanitizeUnifiedDiffMock,
}))

import { ApplyDiffTool, applyDiffTool } from "../ApplyDiffTool"

let lastError: Error | null = null

function createTask(overrides: Record<string, any> = {}) {
	return {
		cwd: "D:\\repo",
		consecutiveMistakeCount: 0,
		consecutiveMistakeCountForApplyDiff: new Map(),
		recordToolError: vi.fn(),
		say: vi.fn(),
		didToolFailInCurrentTurn: false,
		api: {
			getModel: () => ({ id: "claude-3-5" }),
		},
		diffStrategy: {
			applyDiff: vi.fn(),
			getProgressStatus: vi.fn().mockReturnValue({ total: 10, current: 5 }),
		},
		diffViewProvider: {
			reset: vi.fn(),
			open: vi.fn(),
			update: vi.fn(),
			scrollToFirstDiff: vi.fn(),
			saveChanges: vi.fn(),
			revertChanges: vi.fn(),
			saveDirectly: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("applied changes output"),
		},
		fileContextTracker: {
			trackFileContext: vi.fn(),
		},
		providerRef: {
			deref: () => ({
				getState: () => ({
					diagnosticsEnabled: true,
					writeDelayMs: 200,
					experiments: {},
				}),
			}),
		},
		rooProtectedController: {
			isWriteProtected: async () => false,
		},
		rooIgnoreController: {},
		processQueuedMessages: vi.fn(),
		...overrides,
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn((action, err) => {
			lastError = err
		}),
		pushToolResult: vi.fn(),
	}
}

describe("ApplyDiffTool", () => {
	let tool: ApplyDiffTool

	beforeEach(() => {
		vi.clearAllMocks()
		lastError = null
		tool = new ApplyDiffTool()
		allowRooIgnorePathAccessMock.mockReturnValue(true)
		isPathOutsideWorkspaceMock.mockReturnValue(false)
		fileExistsAtPathMock.mockReturnValue(true)
		experimentsIsEnabledMock.mockReturnValue(false)
		sanitizeUnifiedDiffMock.mockImplementation((s: string) => s)
		computeDiffStatsMock.mockReturnValue({ added: 5, deleted: 3 })
	})

	afterEach(() => {
		if (lastError) {
			console.error("CAPTURE ERROR IN TEST:", lastError)
		}
	})

	it("has correct properties", () => {
		expect(tool.name).toBe("apply_diff")
		expect(tool.requiresCheckpoint).toBe(true)
		expect(tool.interruptBehavior()).toBe("block")
		expect(tool.userFacingName()).toBe("Apply Diff")
		expect(applyDiffTool).toBeInstanceOf(ApplyDiffTool)
	})

	it("fails early if path access is blocked by rooignore", async () => {
		allowRooIgnorePathAccessMock.mockReturnValueOnce(false)
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ path: "secret.txt", diff: "diffContent" }, task, callbacks)

		expect(task.say).toHaveBeenCalledWith("rooignore_error", "secret.txt")
		expect(callbacks.pushToolResult).toHaveBeenCalled()
	})

	it("fails if path is outside workspace", async () => {
		isPathOutsideWorkspaceMock.mockReturnValueOnce(true)
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ path: "../outside.ts", diff: "diff" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_diff")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Safety: cannot apply diff to path outside workspace"),
		)
	})

	it("fails if file does not exist", async () => {
		fileExistsAtPathMock.mockReturnValueOnce(false)
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ path: "missing.ts", diff: "diff" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_diff")
		expect(task.say).toHaveBeenCalledWith("error", expect.any(String))
		expect(task.didToolFailInCurrentTurn).toBe(true)
	})

	it("fails if diff strategy application fails", async () => {
		const task = createTask()
		task.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: false,
			error: "Diff block not found",
		})
		const callbacks = createCallbacks()
		vi.mocked(fs.readFile).mockResolvedValueOnce("original contents")

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_diff", expect.any(String))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Diff block not found"))
	})

	it("succeeds but returns early if diff produces no changes", async () => {
		const task = createTask()
		task.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: true,
			content: "original contents",
		})
		const callbacks = createCallbacks()
		vi.mocked(fs.readFile).mockResolvedValueOnce("original contents")

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No changes applied"))
		expect(task.diffViewProvider.reset).toHaveBeenCalled()
	})

	it("saves changes directly if preventFocusDisruption is enabled", async () => {
		experimentsIsEnabledMock.mockReturnValueOnce(true)
		const task = createTask()
		task.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: true,
			content: "new contents",
		})
		const callbacks = createCallbacks()
		vi.mocked(fs.readFile).mockResolvedValueOnce("original contents")

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(callbacks.askApproval).toHaveBeenCalled()
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("exists.ts", "new contents", false, true, 200)
		expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("exists.ts", "njust_ai_edited")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("applied changes output")
	})

	it("saves changes via diff view if preventFocusDisruption is disabled", async () => {
		const task = createTask()
		task.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: true,
			content: "new contents",
		})
		const callbacks = createCallbacks()
		vi.mocked(fs.readFile).mockResolvedValueOnce("original contents")

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("exists.ts")
		expect(task.diffViewProvider.update).toHaveBeenCalledWith("new contents", true)
		expect(callbacks.askApproval).toHaveBeenCalled()
		expect(task.diffViewProvider.saveChanges).toHaveBeenCalledWith(true, 200)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("applied changes output")
	})

	it("reverts changes if user denies approval", async () => {
		const task = createTask()
		task.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: true,
			content: "new contents",
		})
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValueOnce(false)
		vi.mocked(fs.readFile).mockResolvedValueOnce("original contents")

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(task.diffViewProvider.revertChanges).toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("handles exception thrown during execution", async () => {
		const task = createTask()
		vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("File read error"))
		const callbacks = createCallbacks()

		await tool.execute({ path: "exists.ts", diff: "diff" }, task, callbacks)

		expect(callbacks.handleError).toHaveBeenCalledWith("applying diff", expect.any(Error))
		expect(task.diffViewProvider.reset).toHaveBeenCalled()
	})
})
