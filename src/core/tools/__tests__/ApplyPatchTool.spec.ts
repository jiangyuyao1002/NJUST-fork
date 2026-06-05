import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import path from "path"
import fs from "fs/promises"

// Hoist mocks
const {
	allowRooIgnorePathAccessMock,
	isPathOutsideWorkspaceMock,
	fileExistsAtPathMock,
	experimentsIsEnabledMock,
	computeDiffStatsMock,
	sanitizeUnifiedDiffMock,
	parsePatchMock,
	processAllHunksMock,
	cangjiePreflightCheckMock,
	buildSearchGateWarningMock,
	resolveRootPackageNameMock,
} = vi.hoisted(() => ({
	allowRooIgnorePathAccessMock: vi.fn(),
	isPathOutsideWorkspaceMock: vi.fn(),
	fileExistsAtPathMock: vi.fn(),
	experimentsIsEnabledMock: vi.fn(),
	computeDiffStatsMock: vi.fn(),
	sanitizeUnifiedDiffMock: vi.fn(),
	parsePatchMock: vi.fn(),
	processAllHunksMock: vi.fn(),
	cangjiePreflightCheckMock: vi.fn(),
	buildSearchGateWarningMock: vi.fn(),
	resolveRootPackageNameMock: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		unlink: vi.fn(),
		mkdir: vi.fn(),
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

vi.mock("../apply-patch", () => ({
	ParseError: class ParseError extends Error {},
	parsePatch: parsePatchMock,
	processAllHunks: processAllHunksMock,
}))

vi.mock("../cangjiePreflightCheck", () => ({
	cangjiePreflightCheck: cangjiePreflightCheckMock,
	buildSearchGateWarning: buildSearchGateWarningMock,
	CRITICAL_SIGNATURE_MODULES: [],
	resolveRootPackageName: resolveRootPackageNameMock,
}))

import { ApplyPatchTool, applyPatchTool } from "../ApplyPatchTool"
import { ParseError } from "../apply-patch"

let lastError: Error | null = null

function createTask(overrides: Record<string, any> = {}) {
	return {
		cwd: "D:\\repo",
		consecutiveMistakeCount: 0,
		consecutiveMistakeCountForApplyDiff: new Map(),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		say: vi.fn(),
		didToolFailInCurrentTurn: false,
		taskMode: "default",
		didEditFile: false,
		cangjieSearchHistory: new Set(),
		cangjieRuntimePolicy: {
			validateProjectStructureForWrite: vi.fn().mockResolvedValue(undefined),
			ensureProjectInitializedForWrite: vi.fn().mockResolvedValue(undefined),
			getMissingImportEvidence: vi.fn().mockReturnValue([]),
			noteWriteApplied: vi.fn(),
			notePathDeleted: vi.fn(),
		},
		diffViewProvider: {
			reset: vi.fn(),
			open: vi.fn(),
			update: vi.fn(),
			scrollToFirstDiff: vi.fn(),
			saveChanges: vi.fn(),
			revertChanges: vi.fn(),
			saveDirectly: vi.fn(),
			pushToolWriteResult: vi.fn().mockResolvedValue("applied patch output"),
			editType: undefined,
			originalContent: undefined,
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
			isWriteProtected: vi.fn().mockResolvedValue(false),
		},
		rooIgnoreController: {},
		processQueuedMessages: vi.fn(),
		ask: vi.fn().mockResolvedValue(true),
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

describe("ApplyPatchTool", () => {
	let tool: ApplyPatchTool

	beforeEach(() => {
		vi.clearAllMocks()
		lastError = null
		tool = new ApplyPatchTool()
		allowRooIgnorePathAccessMock.mockReturnValue(true)
		isPathOutsideWorkspaceMock.mockReturnValue(false)
		fileExistsAtPathMock.mockReturnValue(true)
		experimentsIsEnabledMock.mockReturnValue(false)
		sanitizeUnifiedDiffMock.mockImplementation((s: string) => s)
		computeDiffStatsMock.mockReturnValue({ added: 5, deleted: 3 })
		cangjiePreflightCheckMock.mockReturnValue({ pass: true, errors: [], warnings: [] })
		buildSearchGateWarningMock.mockReturnValue("")
		resolveRootPackageNameMock.mockResolvedValue("root-pkg")
	})

	afterEach(() => {
		if (lastError) {
			console.error("CAPTURE ERROR IN TEST:", lastError)
		}
	})

	it("has correct properties", () => {
		expect(tool.name).toBe("apply_patch")
		expect(tool.requiresCheckpoint).toBe(true)
		expect(tool.isConcurrencySafe()).toBe(true)
		expect(tool.interruptBehavior()).toBe("block")
		expect(tool.userFacingName()).toBe("Apply Patch")
		expect(applyPatchTool).toBeInstanceOf(ApplyPatchTool)
	})

	it("fails if parsePatch throws a ParseError", async () => {
		parsePatchMock.mockImplementationOnce(() => {
			throw new ParseError("Invalid patch start")
		})
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ patch: "bad patch" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Invalid patch format: Invalid patch start"),
		)
	})

	it("fails with generic error if parsePatch throws other errors", async () => {
		parsePatchMock.mockImplementationOnce(() => {
			throw new Error("Generic parser failure")
		})
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ patch: "bad patch" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Failed to parse patch: Generic parser failure"),
		)
	})

	it("succeeds but returns early if there are zero hunks", async () => {
		parsePatchMock.mockReturnValueOnce({ hunks: [] })
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ patch: "empty patch" }, task, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("No file operations found in patch.")
	})

	it("fails if processAllHunks throws an error", async () => {
		parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
		processAllHunksMock.mockRejectedValueOnce(new Error("Hunk processing failed"))
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ patch: "patch" }, task, callbacks)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Failed to process patch: Hunk processing failed"),
		)
	})

	it("stops and reports error if rooignore blocks access", async () => {
		parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
		processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "secret.txt", newContent: "secret" }])
		allowRooIgnorePathAccessMock.mockReturnValueOnce(false)
		const task = createTask()
		const callbacks = createCallbacks()

		await tool.execute({ patch: "patch" }, task, callbacks)

		expect(task.say).toHaveBeenCalledWith("rooignore_error", "secret.txt")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("access_denied"))
	})

	describe("handleAddFile", () => {
		it("fails if add path is outside workspace", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "../outside.ts", newContent: "abc" }])
			isPathOutsideWorkspaceMock.mockReturnValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Safety: cannot create file outside workspace"),
			)
		})

		it("fails if add path already exists", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "exists.ts", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("File already exists"))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("File already exists"))
		})

		it("fails in cangjie mode if project structure validation fails", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask({ taskMode: "cangjie" })
			task.cangjieRuntimePolicy.validateProjectStructureForWrite.mockResolvedValueOnce(
				"Invalid project structure",
			)
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch", "Invalid project structure")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid project structure"))
		})

		it("fails in cangjie mode if project initialization check fails", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask({ taskMode: "cangjie" })
			task.cangjieRuntimePolicy.ensureProjectInitializedForWrite.mockResolvedValueOnce(
				"Uninitialized cjpm project",
			)
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch", "Uninitialized cjpm project")
		})

		it("fails in cangjie mode if preflight check fails", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			cangjiePreflightCheckMock.mockReturnValueOnce({ pass: false, errors: ["Missing main"], warnings: [] })
			const task = createTask({ taskMode: "cangjie" })
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith(
				"apply_patch",
				expect.stringContaining("Cangjie preflight failed"),
			)
		})

		it("fails in cangjie mode if missing bundle corpus evidence is found", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask({ taskMode: "cangjie" })
			task.cangjieRuntimePolicy.getMissingImportEvidence.mockReturnValueOnce(["std.io"])
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith(
				"apply_patch",
				expect.stringContaining("Missing bundled corpus evidence"),
			)
		})

		it("successfully adds file after approval (without preventFocusDisruption)", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.diffViewProvider.open).toHaveBeenCalledWith("src/main.cj")
			expect(task.diffViewProvider.update).toHaveBeenCalledWith("abc", true)
			expect(task.diffViewProvider.saveChanges).toHaveBeenCalled()
			expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("src/main.cj", "njust_ai_edited")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("applied patch output")
		})

		it("successfully adds file after approval (with preventFocusDisruption)", async () => {
			experimentsIsEnabledMock.mockReturnValueOnce(true)
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.diffViewProvider.open).not.toHaveBeenCalled()
			expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("src/main.cj", "abc", true, true, 200)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("applied patch output")
		})

		it("reverts changes if user rejects approval", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "add", path: "src/main.cj", newContent: "abc" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask()
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValueOnce(false)

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.diffViewProvider.revertChanges).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Changes were rejected by the user.")
		})
	})

	describe("handleDeleteFile", () => {
		it("fails if delete path is outside workspace", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "delete", path: "../outside.ts" }])
			isPathOutsideWorkspaceMock.mockReturnValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Safety: cannot delete file outside workspace"),
			)
		})

		it("fails if file to delete does not exist", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "delete", path: "missing.ts" }])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("File not found"))
		})

		it("successfully deletes file on approval", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "delete", path: "exists.ts" }])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(fs.unlink).toHaveBeenCalledWith(path.resolve(task.cwd, "exists.ts"))
			expect(task.cangjieRuntimePolicy.notePathDeleted).toHaveBeenCalledWith("exists.ts")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Successfully deleted exists.ts")
		})

		it("fails if fs.unlink throws an error", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "delete", path: "exists.ts" }])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			vi.mocked(fs.unlink).mockRejectedValueOnce(new Error("Permission denied"))
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("Failed to delete file"))
		})

		it("does not delete file if user rejects approval", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([{ type: "delete", path: "exists.ts" }])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValueOnce(false)

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(fs.unlink).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith("Delete operation was rejected by the user.")
		})
	})

	describe("handleUpdateFile", () => {
		it("fails if update path is outside workspace", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([
				{ type: "update", path: "../outside.ts", originalContent: "a", newContent: "b" },
			])
			isPathOutsideWorkspaceMock.mockReturnValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Safety: cannot update file outside workspace"),
			)
		})

		it("fails if file to update does not exist", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([
				{ type: "update", path: "missing.ts", originalContent: "a", newContent: "b" },
			])
			fileExistsAtPathMock.mockResolvedValueOnce(false)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("File not found"))
		})

		it("returns early if formatResponse.createPrettyPatch returns empty", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([
				{ type: "update", path: "exists.ts", originalContent: "abc", newContent: "abc" },
			])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith("No changes needed for 'exists.ts'")
			expect(task.diffViewProvider.reset).toHaveBeenCalled()
		})

		it("updates file properly after approval (without preventFocusDisruption)", async () => {
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([
				{ type: "update", path: "exists.ts", originalContent: "old", newContent: "new" },
			])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.diffViewProvider.open).toHaveBeenCalledWith("exists.ts")
			expect(task.diffViewProvider.update).toHaveBeenCalledWith("new", true)
			expect(task.diffViewProvider.saveChanges).toHaveBeenCalled()
		})

		it("updates file properly after approval (with preventFocusDisruption)", async () => {
			experimentsIsEnabledMock.mockReturnValueOnce(true)
			parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
			processAllHunksMock.mockResolvedValueOnce([
				{ type: "update", path: "exists.ts", originalContent: "old", newContent: "new" },
			])
			fileExistsAtPathMock.mockResolvedValueOnce(true)
			const task = createTask()
			const callbacks = createCallbacks()

			await tool.execute({ patch: "patch" }, task, callbacks)

			expect(task.diffViewProvider.open).not.toHaveBeenCalled()
			expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("exists.ts", "new", false, true, 200)
		})

		describe("with movePath", () => {
			it("fails if move destination is blocked by rooignore", async () => {
				parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
				processAllHunksMock.mockResolvedValueOnce([
					{
						type: "update",
						path: "exists.ts",
						movePath: "secret.txt",
						originalContent: "old",
						newContent: "new",
					},
				])
				fileExistsAtPathMock.mockResolvedValueOnce(true)
				allowRooIgnorePathAccessMock.mockImplementation((ctrl, p) => p !== "secret.txt")
				const task = createTask()
				const callbacks = createCallbacks()

				await tool.execute({ patch: "patch" }, task, callbacks)

				expect(task.say).toHaveBeenCalledWith("rooignore_error", "secret.txt")
			})

			it("fails if move destination is write protected", async () => {
				parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
				processAllHunksMock.mockResolvedValueOnce([
					{
						type: "update",
						path: "exists.ts",
						movePath: "protected.ts",
						originalContent: "old",
						newContent: "new",
					},
				])
				fileExistsAtPathMock.mockResolvedValueOnce(true)
				const task = createTask()
				task.rooProtectedController.isWriteProtected.mockImplementation(async (p: string) => p === "protected.ts")
				const callbacks = createCallbacks()

				await tool.execute({ patch: "patch" }, task, callbacks)

				expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
				expect(task.say).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("Cannot move file to write-protected path"),
				)
			})

			it("fails if move destination is outside workspace", async () => {
				parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
				processAllHunksMock.mockResolvedValueOnce([
					{
						type: "update",
						path: "exists.ts",
						movePath: "../outside.ts",
						originalContent: "old",
						newContent: "new",
					},
				])
				fileExistsAtPathMock.mockResolvedValueOnce(true)
				isPathOutsideWorkspaceMock.mockImplementation((p: string) => p.includes("outside.ts"))
				const task = createTask()
				const callbacks = createCallbacks()

				await tool.execute({ patch: "patch" }, task, callbacks)

				expect(task.recordToolError).toHaveBeenCalledWith("apply_patch")
				expect(task.say).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("Cannot move file to path outside workspace"),
				)
			})

			it("moves file after approval (without preventFocusDisruption)", async () => {
				parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
				processAllHunksMock.mockResolvedValueOnce([
					{
						type: "update",
						path: "exists.ts",
						movePath: "new-place.ts",
						originalContent: "old",
						newContent: "new",
					},
				])
				fileExistsAtPathMock.mockResolvedValueOnce(true)
				const task = createTask()
				const callbacks = createCallbacks()

				await tool.execute({ patch: "patch" }, task, callbacks)

				expect(fs.mkdir).toHaveBeenCalled()
				expect(fs.writeFile).toHaveBeenCalledWith(path.resolve(task.cwd, "new-place.ts"), "new", "utf8")
				expect(fs.unlink).toHaveBeenCalledWith(path.resolve(task.cwd, "exists.ts"))
				expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith("new-place.ts", "njust_ai_edited")
			})

			it("moves file after approval (with preventFocusDisruption)", async () => {
				experimentsIsEnabledMock.mockReturnValueOnce(true)
				parsePatchMock.mockReturnValueOnce({ hunks: [{}] })
				processAllHunksMock.mockResolvedValueOnce([
					{
						type: "update",
						path: "exists.ts",
						movePath: "new-place.ts",
						originalContent: "old",
						newContent: "new",
					},
				])
				fileExistsAtPathMock.mockResolvedValueOnce(true)
				const task = createTask()
				const callbacks = createCallbacks()

				await tool.execute({ patch: "patch" }, task, callbacks)

				expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledWith("new-place.ts", "new", false, true, 200)
				expect(fs.unlink).toHaveBeenCalledWith(path.resolve(task.cwd, "exists.ts"))
			})
		})
	})

	describe("handlePartial", () => {
		it("calls task.ask with parsed preview and path", async () => {
			const task = createTask()
			const patchContent = "*** Begin Patch\n*** Update File: src/somefile.ts\n@@\n-old\n+new"
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "apply_patch",
				params: { patch: patchContent },
				partial: true,
			})

			expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("src/somefile.ts"), true)
		})

		it("falls back to default preview and workspace path if patch is empty", async () => {
			const task = createTask()
			await tool.handlePartial(task, {
				type: "tool_use",
				name: "apply_patch",
				params: { patch: "" },
				partial: true,
			})

			expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("Parsing patch..."), true)
		})
	})
})
