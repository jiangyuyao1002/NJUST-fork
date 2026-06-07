// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"

import { parseCangjieDefinitions, type CangjieDef } from "../../../services/tree-sitter/cangjieParser"

import { extractImports } from "./CangjieDependencyResolver"

const PACKAGE_DECL_REGEX = /^\s*package\s+([\w.]+)\s*$/m

export interface StructuredEditingContextPreparse {
	content: string
	lines: string[]
	imports: string[]
	defs: CangjieDef[]
	diagnosticsByFile?: Map<string, vscode.Diagnostic[]>
}

export function collectActiveCangjieEditorSnapshot(): {
	imports: string[]
	symbols: string | null
	activePreparse?: StructuredEditingContextPreparse
} {
	const allImports: string[] = []
	const MAX_DEFS = 30
	const fileSymbols: Array<{ fileName: string; defs: CangjieDef[] }> = []
	let totalDefs = 0
	const activeEditor = vscode.window.activeTextEditor
	let activePreparse: StructuredEditingContextPreparse | undefined

	for (const editor of vscode.window.visibleTextEditors) {
		if (!(editor.document.languageId === "cangjie" || editor.document.fileName.endsWith(".cj"))) {
			continue
		}
		const content = editor.document.getText()
		const lines = content.split("\n")
		const importsForDoc = extractImports(content)
		allImports.push(...importsForDoc)
		const parsedDefs = parseCangjieDefinitions(content)
		if (activeEditor && editor.document.uri.toString() === activeEditor.document.uri.toString()) {
			activePreparse = {
				content,
				lines,
				imports: importsForDoc,
				defs: parsedDefs,
			}
		}
		const defs = parsedDefs.filter((d: CangjieDef) => d.kind !== "import" && d.kind !== "package")
		if (defs.length === 0) continue
		fileSymbols.push({ fileName: path.basename(editor.document.fileName), defs })
		totalDefs += defs.length
	}

	const imports = [...new Set(allImports)]
	if (fileSymbols.length === 0) return { imports, symbols: null, activePreparse }

	const lines: string[] = ["## 当前编辑文件的符号定义\n"]
	let remaining = MAX_DEFS
	for (const { fileName, defs } of fileSymbols) {
		lines.push(`**${fileName}**:`)

		const topLevel =
			totalDefs > MAX_DEFS
				? defs.filter((d) => ["class", "struct", "interface", "enum", "extend", "main"].includes(d.kind))
				: defs

		for (const def of topLevel) {
			if (remaining <= 0) break
			const span = def.endLine > def.startLine ? ` (${def.startLine + 1}-${def.endLine + 1} 行)` : ""

			const memberKinds = new Set(["func", "prop", "init", "operator"])
			const children = defs.filter(
				(d) => d !== def && d.startLine > def.startLine && d.endLine <= def.endLine && memberKinds.has(d.kind),
			)

			if (children.length > 0) {
				const childNames = children
					.slice(0, 5)
					.map((c) => `${c.kind}:${c.name}`)
					.join(", ")
				const suffix = children.length > 5 ? ` 等 ${children.length} 个成员` : ""
				lines.push(`- ${def.kind} ${def.name}${span}: 包含 ${childNames}${suffix}`)
			} else {
				lines.push(`- ${def.kind} ${def.name}${span}`)
			}
			remaining--
		}

		if (remaining <= 0) {
			lines.push(`- …（已省略，共 ${totalDefs} 个定义）`)
			break
		}
	}

	return { imports, symbols: lines.join("\n"), activePreparse }
}

export function getActiveCangjieFileInfo(): {
	filePath: string
	packageName: string | null
	cursorLine: number
} | null {
	const editor = vscode.window.activeTextEditor
	if (!editor || (editor.document.languageId !== "cangjie" && !editor.document.fileName.endsWith(".cj"))) {
		return null
	}
	const content = editor.document.getText()
	const pkgMatch = content.match(PACKAGE_DECL_REGEX)
	return {
		filePath: editor.document.fileName,
		packageName: pkgMatch?.[1] ?? null,
		cursorLine: editor.selection.active.line,
	}
}
