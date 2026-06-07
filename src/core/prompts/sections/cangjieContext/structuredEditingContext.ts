// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"

import { getCangjiePromptServices } from "../cangjie-context"
import type { CangjieDef } from "../../../../services/interfaces/ICangjiePromptServices"
import { extractImports as _extractImports } from "../CangjieImportParser"
import { getErrorFixDirectiveForDiagnostic as _getErrorFixDirectiveForDiagnostic } from "../CangjieErrorAnalyzer"
import type { StructuredEditingContextPreparse } from "../CangjieSymbolExtractor"

const getErrorFixDirectiveForDiagnostic = _getErrorFixDirectiveForDiagnostic

const HOVER_PROVIDER_TIMEOUT_MS = 1000
const HOVER_TEXT_MAX_CHARS = 4000
const HOVER_POSITION_MEMO_TTL_MS = 1000
let hoverMemo: { key: string; value: string | null; time: number } | null = null

export function hoversToPlainText(hovers: vscode.Hover[]): string {
	const chunks: string[] = []
	for (const h of hovers) {
		for (const c of h.contents) {
			if (typeof c === "string") {
				chunks.push(c)
			} else {
				chunks.push((c as vscode.MarkdownString).value)
			}
		}
	}
	return chunks.join("\n\n").replace(/\r\n/g, "\n").trim()
}

/**
 * Best-effort LSP hover at cursor via VS Code command API (no direct LanguageClient).
 */
export async function fetchHoverAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
): Promise<string | null> {
	const hoverEnabled = vscode.workspace.getConfiguration("njust-ai").get<boolean>("cangjieLsp.enabled", true)
	if (!hoverEnabled) return null
	const key = `${document.uri.toString()}:${position.line}:${position.character}`
	const now = Date.now()
	if (hoverMemo && hoverMemo.key === key && now - hoverMemo.time < HOVER_POSITION_MEMO_TTL_MS) {
		return hoverMemo.value
	}
	try {
		const task = vscode.commands.executeCommand("vscode.executeHoverProvider", document.uri, position) as Thenable<
			vscode.Hover[] | undefined
		>

		const hovers = await Promise.race([
			task,
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), HOVER_PROVIDER_TIMEOUT_MS)),
		])
		if (!hovers?.length) {
			hoverMemo = { key, value: null, time: now }
			return null
		}
		const text = hoversToPlainText(hovers)
		if (!text) {
			hoverMemo = { key, value: null, time: now }
			return null
		}
		const value = text.length > HOVER_TEXT_MAX_CHARS ? `${text.slice(0, HOVER_TEXT_MAX_CHARS)}…` : text
		hoverMemo = { key, value, time: now }
		return value
	} catch {
		hoverMemo = { key, value: null, time: now }
		return null
	}
}

/**
 * Build a structured editing context for the AI when the user is actively
 * editing a Cangjie file. Includes file info, current function, imports,
 * LSP hover at cursor, nearby code, and recent diagnostics.
 */
export async function buildStructuredEditingContext(pre?: StructuredEditingContextPreparse): Promise<string | null> {
	const editor = vscode.window.activeTextEditor
	if (!editor || (editor.document.languageId !== "cangjie" && !editor.document.fileName.endsWith(".cj"))) {
		return null
	}

	const doc = editor.document
	const position = editor.selection.active
	const cursorLine = position.line
	const content = doc.getText()
	const usePre = pre !== undefined && pre.content === content
	const defs = usePre ? pre.defs : getCangjiePromptServices().getCangjieParser().parseCangjieDefinitions(content)
	const imports = usePre ? pre.imports : _extractImports(content)
	const lines = usePre ? pre.lines : content.split("\n")

	const parts: string[] = []

	// File info
	const fileName = path.basename(doc.fileName)
	parts.push(`当前文件: ${fileName}`)

	// Imports
	if (imports.length > 0) {
		parts.push(`已导入: ${imports.slice(0, 10).join(", ")}${imports.length > 10 ? " …" : ""}`)
	}

	// Current function/class context
	const enclosing = defs
		.filter(
			(d: CangjieDef) =>
				d.startLine <= cursorLine && d.endLine >= cursorLine && d.kind !== "import" && d.kind !== "package",
		)
		.sort((a: CangjieDef, b: CangjieDef) => b.startLine - a.startLine)

	if (enclosing.length > 0) {
		const innermost = enclosing[0]!
		const sig = getCangjiePromptServices().getCangjieParser().computeCangjieSignature(lines, innermost)
		if (enclosing.length > 1) {
			const outermost = enclosing[enclosing.length - 1]!
			parts.push(
				`外层作用域: ${outermost.kind} ${outermost.name} (第 ${outermost.startLine + 1}–${outermost.endLine + 1} 行)`,
			)
			// Inject type member summaries for enclosing type (up to 8 members)
			if (["class", "struct", "interface", "enum"].includes(outermost.kind)) {
				const memberDefs = defs.filter(
					(d: CangjieDef) =>
						d.startLine >= outermost.startLine &&
						d.endLine <= outermost.endLine &&
						d !== outermost &&
						(d.kind === "func" || d.kind === "prop" || d.kind === "var" || d.kind === "let"),
				)
				if (memberDefs.length > 0) {
					const memberSummaries = memberDefs.slice(0, 8).map((m: CangjieDef) => {
						const memberSig = getCangjiePromptServices()
							.getCangjieParser()
							.computeCangjieSignature(lines, m)
						return `  - ${m.kind} ${m.name}: ${memberSig}`
					})
					parts.push(`${outermost.kind} ${outermost.name} 的成员:\n${memberSummaries.join("\n")}`)
				}
			}
		}
		parts.push(`正在编辑: ${innermost.kind} ${innermost.name} (第 ${innermost.startLine + 1} 行)`)
		parts.push(`签名: ${sig}`)
	}

	const hover = await fetchHoverAtPosition(doc, position)
	if (hover) {
		parts.push(`光标处 LSP 提示:\n${hover}`)
	}

	// Nearby code (±8 lines around cursor)
	const startLine = Math.max(0, cursorLine - 8)
	const endLine = Math.min(doc.lineCount - 1, cursorLine + 8)
	const nearbyLines: string[] = []
	for (let i = startLine; i <= endLine; i++) {
		const marker = i === cursorLine ? " >>>" : "    "
		nearbyLines.push(`${marker} ${i + 1}: ${doc.lineAt(i).text}`)
	}
	parts.push(`附近代码:\n${nearbyLines.join("\n")}`)

	// Active diagnostics for this file
	const fileDiags = pre?.diagnosticsByFile?.get(path.normalize(doc.fileName))
	const diags = fileDiags ?? vscode.languages.getDiagnostics(doc.uri)
	const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
	if (errors.length > 0) {
		const errorSummary = errors
			.slice(0, 5)
			.map((d) => {
				const directive = getErrorFixDirectiveForDiagnostic(d)
				return `  - 第 ${d.range.start.line + 1} 行: ${d.message}\n    建议: ${directive}`
			})
			.join("\n")
		parts.push(`当前文件错误:\n${errorSummary}`)
	}

	return `## 当前编辑上下文\n\n${parts.join("\n")}`
}

export function invalidateStructuredEditingContextCache(): void {
	hoverMemo = null
}
