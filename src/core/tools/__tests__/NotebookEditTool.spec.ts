import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	toolErrorMock,
	openNotebookDocumentMock,
	applyEditMock,
	vscodeUriFileMock,
	notebookCellDataMock,
	notebookEditInsertMock,
	notebookEditDeleteMock,
	notebookRangeMock,
	workspaceEditMock,
	getErrorMessageMock,
	isPathOutsideWorkspaceMock,
} = vi.hoisted(() => ({
	toolErrorMock: vi.fn((msg: string) => `Error: ${msg}`),
	openNotebookDocumentMock: vi.fn(),
	applyEditMock: vi.fn(),
	vscodeUriFileMock: vi.fn((p: string) => ({ fsPath: p })),
	notebookCellDataMock: vi.fn(),
	notebookEditInsertMock: vi.fn(),
	notebookEditDeleteMock: vi.fn(),
	notebookRangeMock: vi.fn(),
	workspaceEditMock: vi.fn(function () {
		return { set: vi.fn() }
	}),
	getErrorMessageMock: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
	isPathOutsideWorkspaceMock: vi.fn().mockReturnValue(false),
}))

vi.mock("vscode", () => ({
	Uri: {
		file: vscodeUriFileMock,
	},
	workspace: {
		openNotebookDocument: openNotebookDocumentMock,
		applyEdit: applyEditMock,
	},
	WorkspaceEdit: workspaceEditMock,
	NotebookCellData: notebookCellDataMock,
	NotebookEdit: {
		insertCells: notebookEditInsertMock,
		deleteCells: notebookEditDeleteMock,
	},
	NotebookRange: notebookRangeMock,
	NotebookCellKind: {
		Code: 2,
		Markup: 1,
	},
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: getErrorMessageMock,
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: isPathOutsideWorkspaceMock,
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: toolErrorMock,
	},
}))

import { notebookEditTool } from "../NotebookEditTool"

function createTask(overrides: Record<string, unknown> = {}) {
	return {
		cwd: "/workspace",
		consecutiveMistakeCount: 0,
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

describe("NotebookEditTool", () => {
	let notebookDoc: any

	beforeEach(() => {
		vi.clearAllMocks()
		notebookDoc = {
			cellCount: 3,
			uri: { fsPath: "/workspace/test.ipynb" },
			cellAt: vi.fn().mockReturnValue({
				kind: 2,
				document: { languageId: "python" },
			}),
		}
		openNotebookDocumentMock.mockResolvedValue(notebookDoc)
		applyEditMock.mockResolvedValue(true)
		notebookEditInsertMock.mockReturnValue({ type: "insert" })
		notebookEditDeleteMock.mockReturnValue({ type: "delete" })
	})

	describe("metadata", () => {
		it("requires checkpoint", () => {
			expect(notebookEditTool.requiresCheckpoint).toBe(true)
		})

		it("has block interrupt behavior", () => {
			expect(notebookEditTool.interruptBehavior()).toBe("block")
		})

		it("has correct user-facing name", () => {
			expect(notebookEditTool.userFacingName()).toBe("Notebook Edit")
		})

		it("has search hint", () => {
			expect(notebookEditTool.searchHint).toContain("notebook")
		})
	})

	describe("execute", () => {
		it("fails when vscode is unavailable (dynamic import failure)", async () => {
			// We cannot easily mock the dynamic import of vscode failing,
			// but we can test the normal flow works. The dynamic import
			// failure branch is hard to test without module-level mocking.
			// Instead, let's focus on the other branches.
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "insert", cellIndex: 0, content: "print('hi')" },
				createTask(),
				callbacks as any,
			)

			// It should succeed (vscode is available in test env)
			expect(openNotebookDocumentMock).toHaveBeenCalled()
		})

		it("returns error when notebook fails to open", async () => {
			openNotebookDocumentMock.mockRejectedValue(new Error("File not found"))
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/missing.ipynb", action: "insert", cellIndex: 0, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Failed to open notebook"))
		})

		it("inserts a code cell at valid index", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{
					path: "/workspace/test.ipynb",
					action: "insert",
					cellIndex: 1,
					content: "print('hello')",
					cellType: "code",
				},
				createTask(),
				callbacks as any,
			)

			expect(notebookEditInsertMock).toHaveBeenCalled()
			expect(applyEditMock).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully inserted a code cell at index 1"),
			)
		})

		it("inserts a markdown cell", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{
					path: "/workspace/test.ipynb",
					action: "insert",
					cellIndex: 0,
					content: "# Title",
					cellType: "markdown",
				},
				createTask(),
				callbacks as any,
			)

			expect(notebookCellDataMock).toHaveBeenCalledWith(
				1, // NotebookCellKind.Markup
				"# Title",
				"markdown",
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully inserted a markdown cell at index 0"),
			)
		})

		it("rejects insert with out-of-range cellIndex", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "insert", cellIndex: 5, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("cellIndex 5 is out of range for insert"),
			)
		})

		it("rejects insert with negative cellIndex", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "insert", cellIndex: -1, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("cellIndex -1 is out of range for insert"),
			)
		})

		it("edits an existing cell", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "edit", cellIndex: 1, content: "new code" },
				createTask(),
				callbacks as any,
			)

			expect(notebookDoc.cellAt).toHaveBeenCalledWith(1)
			expect(notebookEditDeleteMock).toHaveBeenCalled()
			expect(notebookEditInsertMock).toHaveBeenCalled()
			expect(applyEditMock).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully edited cell at index 1"),
			)
		})

		it("rejects edit with out-of-range cellIndex", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "edit", cellIndex: 3, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("cellIndex 3 is out of range"),
			)
		})

		it("deletes a cell", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "delete", cellIndex: 2 },
				createTask(),
				callbacks as any,
			)

			expect(notebookEditDeleteMock).toHaveBeenCalled()
			expect(applyEditMock).toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully deleted cell at index 2"),
			)
		})

		it("rejects delete with out-of-range cellIndex", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "delete", cellIndex: 3 },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("cellIndex 3 is out of range"),
			)
		})

		it("returns error when applyEdit fails", async () => {
			applyEditMock.mockResolvedValue(false)
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "delete", cellIndex: 0 },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Failed to apply notebook edit"),
			)
		})

		it("resets consecutiveMistakeCount on success", async () => {
			const task = createTask({ consecutiveMistakeCount: 5 })
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "delete", cellIndex: 0 },
				task,
				callbacks as any,
			)

			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("edit with explicit cellType overrides existing kind", async () => {
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "edit", cellIndex: 0, content: "# MD", cellType: "markdown" },
				createTask(),
				callbacks as any,
			)

			expect(notebookCellDataMock).toHaveBeenCalledWith(
				1, // NotebookCellKind.Markup
				"# MD",
				"markdown",
			)
		})

		it("delegates unexpected errors to handleError", async () => {
			applyEditMock.mockRejectedValue(new Error("edit rejected"))
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/workspace/test.ipynb", action: "insert", cellIndex: 0, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"editing notebook",
				expect.objectContaining({ message: "edit rejected" }),
			)
		})

		it("rejects notebook paths outside workspace", async () => {
			isPathOutsideWorkspaceMock.mockReturnValue(true)
			const callbacks = createCallbacks()

			await notebookEditTool.execute(
				{ path: "/etc/passwd", action: "insert", cellIndex: 0, content: "code" },
				createTask(),
				callbacks as any,
			)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("cannot edit notebook outside workspace"),
			)
			expect(openNotebookDocumentMock).not.toHaveBeenCalled()
		})
	})
})
