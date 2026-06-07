import * as vscode from "vscode"
import { promises as fsPromises } from "fs"
import type { CangjieSymbolIndex } from "./CangjieSymbolIndex"
import { t } from "../../i18n"

/**
 * Enhanced RenameProvider that compares LSP rename results with the local
 * symbol index. When discrepancies are detected, warns the user and offers
 * an index-based rename that may cover additional references.
 */
export class CangjieEnhancedRenameProvider implements vscode.RenameProvider {
	private inLspRename = false

	constructor(private readonly index: CangjieSymbolIndex) {}

	prepareRename(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.Range | undefined {
		const wordRange = document.getWordRangeAtPosition(position)
		if (!wordRange) return undefined

		const word = document.getText(wordRange)
		if (!word || word.length < 2) return undefined

		const defs = this.index.findDefinitions(word, document.uri)
		if (defs.length === 0) return undefined

		return wordRange
	}

	async provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		_token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | undefined> {
		// When VS Code dispatches executeDocumentRenameProvider it re-enters
		// all registered RenameProviders. Skip our logic on re-entry so only
		// the LSP provider responds, avoiding infinite recursion.
		if (this.inLspRename) return undefined

		const wordRange = document.getWordRangeAtPosition(position)
		if (!wordRange) return undefined

		const oldName = document.getText(wordRange)
		if (!oldName || oldName.length < 2) return undefined

		const lspEdit = await this.tryLspRename(document, position, newName)
		const rawIndexRefs = this.index.findReferences(oldName, document.uri)
		const indexRefs = await this.filterRenameCandidates(oldName, rawIndexRefs)

		const lspLocCount = lspEdit ? this.countLocations(lspEdit) : 0
		const indexLocCount = indexRefs.length

		if (lspEdit && indexLocCount > lspLocCount) {
			const diff = indexLocCount - lspLocCount
			const useEnhancedBtn = t("buttons.cangjie_lsp.use_enhanced_rename")
			const useLspBtn = t("buttons.cangjie_lsp.use_lsp_result")
			const cancelBtn = t("buttons.cangjie_lsp.cancel")
			const choice = await vscode.window.showWarningMessage(
				t("warnings.cangjie_lsp.rename_discrepancy", {
					lspCount: lspLocCount,
					indexCount: indexLocCount,
					diff,
				}),
				useEnhancedBtn,
				useLspBtn,
				cancelBtn,
			)

			if (choice === useEnhancedBtn) {
				return this.buildIndexRenameEdit(oldName, newName, indexRefs)
			} else if (choice === useLspBtn) {
				return lspEdit
			}
			return undefined
		}

		if (lspEdit) return lspEdit

		if (indexRefs.length > 0) {
			return this.buildIndexRenameEdit(oldName, newName, indexRefs)
		}

		return undefined
	}

	private async tryLspRename(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
	): Promise<vscode.WorkspaceEdit | undefined> {
		this.inLspRename = true
		try {
			const result = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
				"vscode.executeDocumentRenameProvider",
				document.uri,
				position,
				newName,
			)
			return result && this.countLocations(result) > 0 ? result : undefined
		} catch {
			return undefined
		} finally {
			this.inLspRename = false
		}
	}

	private countLocations(edit: vscode.WorkspaceEdit): number {
		let count = 0
		for (const [, edits] of edit.entries()) {
			count += edits.length
		}
		return count
	}

	private buildIndexRenameEdit(
		oldName: string,
		newName: string,
		refs: Array<{ filePath: string; line: number; column: number }>,
	): vscode.WorkspaceEdit {
		const edit = new vscode.WorkspaceEdit()
		for (const ref of refs) {
			const uri = vscode.Uri.file(ref.filePath)
			const range = new vscode.Range(ref.line, ref.column, ref.line, ref.column + oldName.length)
			edit.replace(uri, range, newName)
		}
		return edit
	}

	private async filterRenameCandidates(
		name: string,
		refs: Array<{ filePath: string; line: number; column: number }>,
	): Promise<Array<{ filePath: string; line: number; column: number }>> {
		const useAst = vscode.workspace
			.getConfiguration("njust-ai")
			.get<boolean>("cangjieTools.useCjcAstForIndex", false)
		if (!useAst) return refs
		const fileCache = new Map<string, string[]>()
		const out: Array<{ filePath: string; line: number; column: number }> = []
		for (const ref of refs) {
			let lines = fileCache.get(ref.filePath)
			if (!lines) {
				try {
					const doc = vscode.workspace.textDocuments.find((d) => d.fileName === ref.filePath)
					const content = doc?.getText()
					if (content !== undefined) lines = content.split("\n")
					else {
						// Use async fs.promises.readFile instead of sync fs.readFileSync
						const fileContent = await fsPromises.readFile(ref.filePath, "utf-8")
						lines = fileContent.split("\n")
					}
					fileCache.set(ref.filePath, lines)
				} catch {
					continue
				}
			}
			const lineText = lines[ref.line]
			if (!lineText) continue
			if (lineText.slice(ref.column, ref.column + name.length) !== name) continue
			if (this.isIdentifierUsage(lineText, ref.column)) {
				out.push(ref)
			}
		}
		return out
	}

	private isIdentifierUsage(line: string, index: number): boolean {
		let inString = false
		let quote = ""
		let escaped = false
		for (let i = 0; i < line.length; i++) {
			const ch = line[i]
			const next = i + 1 < line.length ? line[i + 1] : ""
			if (!inString && ch === "/" && next === "/") return index < i
			if (inString) {
				if (escaped) {
					escaped = false
					if (i === index) return false
					continue
				}
				if (ch === "\\") {
					escaped = true
					if (i === index) return false
					continue
				}
				if (ch === quote) {
					inString = false
					quote = ""
				}
				if (i === index) return false
			} else if (ch === '"' || ch === "'") {
				if (i <= index) {
					inString = true
					quote = ch
				}
			}
			if (i === index) return !inString
		}
		return true
	}
}
