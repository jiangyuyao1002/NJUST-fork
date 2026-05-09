import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import type { CangjieSymbolIndex } from "./CangjieSymbolIndex"
import {
	parseCangjieDefinitions,
	computeCangjieSignature,
	type CangjieDef,
} from "../tree-sitter/cangjieParser"

/**
 * Provides refactoring code actions for Cangjie files:
 *  - Extract Function: extract selected code into a new function
 *  - Move File: move a .cj file and update package declarations + imports
 */
export class CangjieRefactoringProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.RefactorExtract,
		vscode.CodeActionKind.Refactor,
	]

	constructor(private readonly index: CangjieSymbolIndex) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = []

		if (!range.isEmpty) {
			const extractAction = new vscode.CodeAction(
				"Extract Function (Cangjie)",
				vscode.CodeActionKind.RefactorExtract,
			)
			extractAction.command = {
				command: "njust-ai-cj.cangjieExtractFunction",
				title: "Extract Function",
				arguments: [document, range],
			}
			actions.push(extractAction)
		}

		return actions
	}

	/**
	 * Extract the selected code into a new function.
	 * Performs basic analysis of free variables in the selection to build the parameter list.
	 */
	async extractFunction(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
		const selectedText = document.getText(range)
		if (!selectedText.trim()) return

		const funcName = await vscode.window.showInputBox({
			prompt: "新函数名",
			value: "extractedFunction",
			validateInput: (v) => (/^[a-z_]\w*$/i.test(v) ? null : "请输入合法的仓颉标识符"),
		})
		if (!funcName) return

		const freeVars = this.detectFreeVariables(document, range, selectedText)
		const paramList = freeVars.length > 0
			? freeVars.map((v) => `${v.name}: ${v.inferredType}`).join(", ")
			: ""
		const argList = freeVars.map((v) => v.name).join(", ")

		const indent = document.lineAt(range.start.line).text.match(/^(\s*)/)?.[1] ?? ""
		const bodyIndent = indent + "\t"
		const indentedBody = selectedText
			.split("\n")
			.map((line) => bodyIndent + line.trimStart())
			.join("\n")

		const funcDef = `\n${indent}func ${funcName}(${paramList}): Unit {\n${indentedBody}\n${indent}}\n`
		const callSite = `${indent}${funcName}(${argList})`

		const content = document.getText()
		const defs = parseCangjieDefinitions(content)
		const enclosing = defs
			.filter((d: CangjieDef) =>
				d.startLine <= range.start.line &&
				d.endLine >= range.end.line &&
				["class", "struct", "interface", "extend"].includes(d.kind),
			)
			.sort((a: CangjieDef, b: CangjieDef) => b.startLine - a.startLine)

		const edit = new vscode.WorkspaceEdit()
		edit.replace(document.uri, range, callSite)

		const insertionLine = enclosing.length > 0
			? enclosing[0].endLine
			: range.end.line + 2
		const insertPos = new vscode.Position(Math.min(insertionLine, document.lineCount), 0)
		edit.insert(document.uri, insertPos, funcDef)

		await vscode.workspace.applyEdit(edit)
	}

	/**
	 * Move a .cj file to a new directory and update package declarations
	 * and import references across the workspace.
	 */
	async moveFile(sourceUri: vscode.Uri): Promise<void> {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri)
		if (!workspaceFolder) return

		const relSource = path.relative(workspaceFolder.uri.fsPath, sourceUri.fsPath).replace(/\\/g, "/")

		const targetPath = await vscode.window.showInputBox({
			prompt: "目标路径（相对于工作区根目录）",
			value: relSource,
		})
		if (!targetPath || targetPath === relSource) return

		const absTarget = path.join(workspaceFolder.uri.fsPath, targetPath)
		const targetDir = path.dirname(absTarget)

		if (!fs.existsSync(targetDir)) {
			fs.mkdirSync(targetDir, { recursive: true })
		}

		const content = fs.readFileSync(sourceUri.fsPath, "utf-8")

		const oldPackage = this.inferPackageName(sourceUri.fsPath, workspaceFolder.uri.fsPath)
		const newPackage = this.inferPackageName(absTarget, workspaceFolder.uri.fsPath)

		let updatedContent = content
		if (oldPackage && newPackage && oldPackage !== newPackage) {
			updatedContent = content.replace(
				new RegExp(`^(\\s*package\\s+)${oldPackage.replace(/\./g, "\\.")}`, "m"),
				`$1${newPackage}`,
			)
		}

		fs.writeFileSync(absTarget, updatedContent, "utf-8")
		fs.unlinkSync(sourceUri.fsPath)

		if (oldPackage && newPackage && oldPackage !== newPackage) {
			await this.updateImportReferences(workspaceFolder.uri.fsPath, oldPackage, newPackage)
		}

		const doc = await vscode.workspace.openTextDocument(absTarget)
		await vscode.window.showTextDocument(doc)
	}

	private inferPackageName(filePath: string, workspaceRoot: string): string | undefined {
		const rel = path.relative(workspaceRoot, filePath).replace(/\\/g, "/")
		const srcIdx = rel.indexOf("src/")
		if (srcIdx < 0) return undefined
		const afterSrc = rel.slice(srcIdx + 4)
		const dir = path.dirname(afterSrc)
		if (dir === ".") return undefined
		return dir.replace(/\//g, ".")
	}

	private async updateImportReferences(
		workspaceRoot: string,
		oldPackage: string,
		newPackage: string,
	): Promise<void> {
		const files = await vscode.workspace.findFiles("**/*.cj", "**/target/**", 500)
		const edit = new vscode.WorkspaceEdit()

		const oldImportPattern = new RegExp(
			`(import\\s+)${oldPackage.replace(/\./g, "\\.")}(\\.\\*?)`,
			"g",
		)

		for (const uri of files) {
			try {
				const doc = await vscode.workspace.openTextDocument(uri)
				const text = doc.getText()
				if (!text.includes(oldPackage)) continue

				const lines = text.split("\n")
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i]
					oldImportPattern.lastIndex = 0
					if (oldImportPattern.test(line)) {
						const newLine = line.replace(oldImportPattern, `$1${newPackage}$2`)
						const lineRange = new vscode.Range(i, 0, i, line.length)
						edit.replace(uri, lineRange, newLine)
					}
				}
			} catch {
				// Skip unreadable files
			}
		}

		if (edit.size > 0) {
			await vscode.workspace.applyEdit(edit)
		}
	}

	/**
	 * Simple free-variable detection: find identifiers in the selection
	 * that are defined outside it (variable declarations above).
	 */
	private detectFreeVariables(
		document: vscode.TextDocument,
		range: vscode.Range,
		selectedText: string,
	): Array<{ name: string; inferredType: string }> {
		const identRe = /\b([A-Za-z_]\w*)\b/g
		const usedInSelection = new Set<string>()
		let m: RegExpExecArray | null
		while ((m = identRe.exec(selectedText)) !== null) {
			usedInSelection.add(m[1])
		}

		const keywords = new Set([
			"let", "var", "if", "else", "for", "while", "match", "case",
			"return", "import", "package", "func", "class", "struct",
			"interface", "enum", "in", "true", "false", "this", "super",
			"public", "private", "protected", "static", "open", "override",
			"abstract", "sealed", "spawn", "try", "catch", "finally",
			"throw", "break", "continue", "mut", "init", "extend",
		])

		const declRe = /(?:let|var)\s+([a-z_]\w*)\s*(?::\s*(\w[\w<>?,\s]*))?/g
		const contextStart = Math.max(0, range.start.line - 30)
		const contextText = document.getText(
			new vscode.Range(contextStart, 0, range.start.line, 0),
		)

		const declared = new Map<string, string>()
		while ((m = declRe.exec(contextText)) !== null) {
			declared.set(m[1], m[2] ?? "/* infer */")
		}

		const result: Array<{ name: string; inferredType: string }> = []
		for (const name of usedInSelection) {
			if (keywords.has(name)) continue
			if (declared.has(name)) {
				result.push({ name, inferredType: declared.get(name)! })
			}
		}
		return result
	}

	dispose(): void {
		// No resources to dispose
	}
}
