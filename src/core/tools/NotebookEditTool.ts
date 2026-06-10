import { z } from "zod"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getErrorMessage } from "../../shared/error-utils"

interface NotebookEditParams {
	path: string
	action: "insert" | "edit" | "delete"
	cellIndex: number
	content?: string
	cellType?: "code" | "markdown"
}

export class NotebookEditTool extends BaseTool<"notebook_edit"> {
	readonly name = "notebook_edit" as const
	override readonly requiresCheckpoint = true

	override get shouldDefer(): boolean {
		return true
	}

	override interruptBehavior(): "cancel" | "block" {
		return "block"
	}

	override userFacingName(): string {
		return "Notebook Edit"
	}

	override get searchHint(): string {
		return "notebook jupyter cell edit ipynb"
	}

	protected override get inputSchema() {
		return z
			.object({
				path: z.string().min(1, "path is required"),
				action: z.enum(["insert", "edit", "delete"]),
				cellIndex: z.number().int().nonnegative("cellIndex must be a non-negative integer"),
				content: z.string().optional(),
				cellType: z.enum(["code", "markdown"]).optional(),
			})
			.refine(
				(data) => {
					if (data.action === "insert" || data.action === "edit") {
						return typeof data.content === "string" && data.content.length > 0
					}
					return true
				},
				{ message: "content is required for insert and edit actions", path: ["content"] },
			)
	}

	async execute(params: NotebookEditParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError } = callbacks

		try {
			const { path, action, cellIndex, content, cellType } = params

			// Try to use VS Code Notebook API
			let vscode: typeof import("vscode")
			try {
				vscode = await import("vscode")
			} catch {
				pushToolResult(
					formatResponse.toolError(
						"Notebook editing is only available in VS Code environments. " +
							"This tool requires the VS Code Notebook API which is not available in the current environment.",
					),
				)
				return
			}

			const uri = vscode.Uri.file(path)

			// Open the notebook document
			let notebookDoc: import("vscode").NotebookDocument
			try {
				notebookDoc = await vscode.workspace.openNotebookDocument(uri)
			} catch (err) {
				pushToolResult(
					formatResponse.toolError(`Failed to open notebook at '${path}': ${getErrorMessage(err)}`),
				)
				return
			}

			const cellCount = notebookDoc.cellCount

			// Validate cellIndex bounds
			if (action === "insert") {
				if (cellIndex < 0 || cellIndex > cellCount) {
					pushToolResult(
						formatResponse.toolError(
							`cellIndex ${cellIndex} is out of range for insert. Valid range: 0-${cellCount}.`,
						),
					)
					return
				}
			} else {
				if (cellIndex < 0 || cellIndex >= cellCount) {
					pushToolResult(
						formatResponse.toolError(
							`cellIndex ${cellIndex} is out of range. Valid range: 0-${cellCount - 1}.`,
						),
					)
					return
				}
			}

			const edit = new vscode.WorkspaceEdit()
			const notebookUri = notebookDoc.uri

			switch (action) {
				case "insert": {
					const kind = cellType === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code
					const languageId = cellType === "markdown" ? "markdown" : "python"
					const cellData = new vscode.NotebookCellData(kind, content!, languageId)
					const notebookEdit = vscode.NotebookEdit.insertCells(cellIndex, [cellData])
					edit.set(notebookUri, [notebookEdit])
					break
				}

				case "edit": {
					// Replace cell content by deleting and reinserting
					const existingCell = notebookDoc.cellAt(cellIndex)
					const kind = cellType
						? cellType === "markdown"
							? vscode.NotebookCellKind.Markup
							: vscode.NotebookCellKind.Code
						: existingCell.kind
					const languageId =
						kind === vscode.NotebookCellKind.Markup ? "markdown" : existingCell.document.languageId
					const cellData = new vscode.NotebookCellData(kind, content!, languageId)
					const deleteEdit = vscode.NotebookEdit.deleteCells(
						new vscode.NotebookRange(cellIndex, cellIndex + 1),
					)
					const insertEdit = vscode.NotebookEdit.insertCells(cellIndex, [cellData])
					edit.set(notebookUri, [deleteEdit, insertEdit])
					break
				}

				case "delete": {
					const deleteEdit = vscode.NotebookEdit.deleteCells(
						new vscode.NotebookRange(cellIndex, cellIndex + 1),
					)
					edit.set(notebookUri, [deleteEdit])
					break
				}
			}

			const success = await vscode.workspace.applyEdit(edit)

			if (!success) {
				pushToolResult(
					formatResponse.toolError(`Failed to apply notebook edit. The workspace edit was rejected.`),
				)
				return
			}

			task.consecutiveMistakeCount = 0

			switch (action) {
				case "insert":
					pushToolResult(
						`Successfully inserted a ${cellType || "code"} cell at index ${cellIndex} in '${path}'.`,
					)
					break
				case "edit":
					pushToolResult(`Successfully edited cell at index ${cellIndex} in '${path}'.`)
					break
				case "delete":
					pushToolResult(`Successfully deleted cell at index ${cellIndex} in '${path}'.`)
					break
			}
		} catch (error) {
			await handleError("editing notebook", error as Error)
		}
	}
}

export const notebookEditTool = new NotebookEditTool()
