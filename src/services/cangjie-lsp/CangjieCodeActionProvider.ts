import * as vscode from "vscode"
import { inferCangjiePackageFromSrcLayout } from "./cangjieSourceLayout"
import { t } from "../../i18n"

interface QuickFixPattern {
	pattern: RegExp
	createFix: (
		document: vscode.TextDocument,
		diagnostic: vscode.Diagnostic,
		match: RegExpMatchArray,
	) => vscode.CodeAction | undefined
}

const STDLIB_IMPORT_HINTS: Record<string, string> = {
	ArrayList: "std.collection",
	HashMap: "std.collection",
	HashSet: "std.collection",
	LinkedList: "std.collection",
	File: "std.fs",
	Path: "std.fs",
	Socket: "std.net",
	HttpClient: "std.net",
	Mutex: "std.sync",
	AtomicInt: "std.sync",
	AtomicBool: "std.sync",
	Duration: "std.time",
	DateTime: "std.time",
	Regex: "std.regex",
	Random: "std.random",
	Process: "std.process",
	StringBuilder: "std.core",
	Console: "std.console",
}

function findLetDeclarationForSymbol(
	document: vscode.TextDocument,
	errorLine: number,
	errorMessage: string,
): { line: number; letStart: number } | null {
	// Try to extract the symbol name from the diagnostic message
	const symMatch = errorMessage.match(/['"`](\w+)['"`]/)
	const symbolName = symMatch?.[1]

	if (symbolName) {
		// Search for `let <symbolName>` in code before the error line
		const text = document.getText(new vscode.Range(0, 0, errorLine, 0))
		const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		const letSymRe = new RegExp(`^(\\s*)let\\s+${escaped}\\b`, "m")
		const m = text.match(letSymRe)
		if (m) {
			const lineIdx = text.slice(0, m.index!).split("\n").length - 1
			const lineText = document.lineAt(lineIdx).text
			// Check the "let" is outside a comment or string by verifying the prefix
			const prefixBeforeLet = lineText.substring(0, lineText.indexOf("let")).trim()
			const cleanPrefix = prefixBeforeLet.replace(/\/\/.*$/m, "").trim()
			const letIdx = cleanPrefix
				? lineText.indexOf("let", lineText.indexOf(cleanPrefix) + cleanPrefix.length)
				: lineText.indexOf("let")
			if (letIdx === -1) return null
			return { line: lineIdx, letStart: letIdx }
		}
	}

	// Fallback: search backwards from the error line for the nearest `let` declaration
	for (let i = errorLine; i >= 0; i--) {
		const lineText = document.lineAt(i).text
		const letMatch = lineText.match(/^(\s*)let\b/)
		if (letMatch) {
			return { line: i, letStart: lineText.indexOf("let") }
		}
	}
	return null
}

function inferReturnValue(returnType: string | null): string {
	if (!returnType) return "0"
	const t = returnType.replace(/\s+/g, "").toLowerCase()
	if (t.includes("int64") || t.includes("int32") || /\bint\b/.test(t)) return "0"
	if (t.includes("uint64") || t.includes("uint32") || /\buint\b/.test(t)) return "0"
	if (t.includes("float64") || t.includes("float32")) return "0.0"
	if (t.includes("string")) return '""'
	if (t.includes("bool")) return "false"
	if (t.includes("unit") || t.includes("void")) return ""
	if (t.includes("?") || t.includes("option")) return "None"
	// Best-effort: return zero-value constructor for the type name
	if (t.includes("rune")) return "'\0'"
	if (t.includes("array") || t.includes("list") || t.includes("vector")) return "[]"
	if (t.includes("map") || t.includes("hashmap") || t.includes("dictionary")) return "{}"
	// Fallback: type constructor with default fields
	const baseName = returnType.replace(/<.*/, "").trim()
	if (baseName && /^[A-Z]/.test(baseName)) return `${baseName}()`
	return 'throw Exception("Not implemented")'
}

function extractFunctionReturnType(document: vscode.TextDocument, beforeBraceLine: number): string | null {
	for (let i = beforeBraceLine; i >= Math.max(0, beforeBraceLine - 5); i--) {
		const line = document.lineAt(i).text
		const m = line.match(/\)\s*:\s*(\S[\s\S]*?)\s*(?:\{|$)/)
		if (m) return m[1]!.trim()
	}
	return null
}

function inferMatchDefaultValue(document: vscode.TextDocument, matchLine: number): string {
	for (let i = matchLine; i >= Math.max(0, matchLine - 10); i--) {
		const line = document.lineAt(i).text
		if (/\bmatch\b/.test(line)) {
			const trimmed = line.trim()
			if (/=\s*$/.test(trimmed) || /\breturn\b/.test(line)) {
				return `throw Exception("Unhandled case")`
			}
			break
		}
	}
	return "()"
}

function findInsertPosition(document: vscode.TextDocument): vscode.Position {
	let lastImportLine = -1
	let packageLine = -1
	for (let i = 0; i < Math.min(document.lineCount, 50); i++) {
		const text = document.lineAt(i).text.trim()
		if (text.startsWith("package ")) {
			packageLine = i
		}
		if (text.startsWith("import ")) {
			lastImportLine = i
		}
	}
	if (lastImportLine >= 0) {
		return new vscode.Position(lastImportLine + 1, 0)
	}
	if (packageLine >= 0) {
		return new vscode.Position(packageLine + 1, 0)
	}
	return new vscode.Position(0, 0)
}

// Regex patterns match Cangjie compiler error messages (which may be in Chinese).
// Chinese in patterns is intentional — not i18n'd.
const QUICK_FIX_PATTERNS: QuickFixPattern[] = [
	{
		pattern: /(?:undeclared|cannot find|not found|未找到符号|unresolved)\b.*?\b(\w+)/i,
		createFix(document, diagnostic, match) {
			let symbolName = match[1]!
			const quoted = diagnostic.message.match(/['"`](\w+)['"`]/)
			if (quoted?.[1]) symbolName = quoted[1]
			const pkg = STDLIB_IMPORT_HINTS[symbolName]
			if (!pkg) return undefined

			const importLine = `import ${pkg}.*\n`
			const pos = findInsertPosition(document)

			const existingText = document.getText()
			// Word-boundary check: import pkg. or import pkg{ or import pkg\n
			if (new RegExp(`import\\s+${pkg.replace(/\./g, "\\.")}(?:\\s|\\{|$|\\*)`, "m").test(existingText))
				return undefined

			const action = new vscode.CodeAction(
				t("code_actions.cangjie_lsp.add_import", { pkg }),
				vscode.CodeActionKind.QuickFix,
			)
			action.diagnostics = [diagnostic]
			action.isPreferred = true
			const edit = new vscode.WorkspaceEdit()
			edit.insert(document.uri, pos, importLine)
			action.edit = edit
			return action
		},
	},
	{
		pattern: /(?:immutable|cannot assign|let.*reassign|不可变|mut.*let|let.*mut)/i,
		createFix(document, diagnostic) {
			const errorLine = diagnostic.range.start.line
			const pos = findLetDeclarationForSymbol(document, errorLine, diagnostic.message)
			if (!pos) return undefined

			const action = new vscode.CodeAction(
				t("code_actions.cangjie_lsp.let_to_var"),
				vscode.CodeActionKind.QuickFix,
			)
			action.diagnostics = [diagnostic]
			const edit = new vscode.WorkspaceEdit()
			edit.replace(document.uri, new vscode.Range(pos.line, pos.letStart, pos.line, pos.letStart + 3), "var")
			action.edit = edit
			return action
		},
	},
	{
		pattern: /(?:non-exhaustive|not exhaustive|未穷尽|incomplete match)/i,
		createFix(document, diagnostic) {
			const matchLine = diagnostic.range.start.line

			for (let i = matchLine; i < Math.min(document.lineCount, matchLine + 30); i++) {
				const lineText = document.lineAt(i).text
				if (lineText.trim() === "}") {
					const indent = lineText.match(/^(\s*)/)?.[1] || ""
					const defaultValue = inferMatchDefaultValue(document, matchLine)
					const label =
						defaultValue === "()"
							? t("code_actions.cangjie_lsp.add_wildcard_case")
							: t("code_actions.cangjie_lsp.add_wildcard_case_check_return")
					const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix)
					action.diagnostics = [diagnostic]
					const edit = new vscode.WorkspaceEdit()
					edit.insert(document.uri, new vscode.Position(i, 0), `${indent}\tcase _ => ${defaultValue}\n`)
					action.edit = edit
					return action
				}
			}
			return undefined
		},
	},
	{
		pattern: /(?:missing return|no return|缺少返回|return expected)/i,
		createFix(document, diagnostic) {
			const line = diagnostic.range.start.line

			for (let i = line; i < Math.min(document.lineCount, line + 20); i++) {
				const lineText = document.lineAt(i).text
				if (lineText.trim() === "}") {
					const indent = lineText.match(/^(\s*)/)?.[1] || ""
					const returnType = extractFunctionReturnType(document, i)
					const returnVal = inferReturnValue(returnType)
					const label = returnType
						? t("code_actions.cangjie_lsp.add_return_typed", { returnType })
						: t("code_actions.cangjie_lsp.add_return")
					const action = new vscode.CodeAction(label, vscode.CodeActionKind.QuickFix)
					action.diagnostics = [diagnostic]
					const edit = new vscode.WorkspaceEdit()
					if (returnVal) {
						edit.insert(document.uri, new vscode.Position(i, 0), `${indent}\treturn ${returnVal}\n`)
					}
					action.edit = edit
					return action
				}
			}
			return undefined
		},
	},
	{
		pattern: /(?:missing import|import.*not found|未导入)\b.*?\b(\w+)/i,
		createFix(document, diagnostic, match) {
			let symbolName = match[1]!
			const quoted = diagnostic.message.match(/['"`](\w+)['"`]/)
			if (quoted?.[1]) symbolName = quoted[1]
			const pkg = STDLIB_IMPORT_HINTS[symbolName]
			if (!pkg) return undefined

			const existingText = document.getText()
			// Word-boundary check: import pkg. or import pkg{ or import pkg\n
			if (new RegExp(`import\\s+${pkg.replace(/\./g, "\\.")}(?:\\s|\\{|$|\\*)`, "m").test(existingText))
				return undefined

			const importLine = `import ${pkg}.*\n`
			const pos = findInsertPosition(document)

			const action = new vscode.CodeAction(
				t("code_actions.cangjie_lsp.add_import", { pkg }),
				vscode.CodeActionKind.QuickFix,
			)
			action.diagnostics = [diagnostic]
			action.isPreferred = true
			const edit = new vscode.WorkspaceEdit()
			edit.insert(document.uri, pos, importLine)
			action.edit = edit
			return action
		},
	},
	{
		pattern: /(?:missing package|package declaration|expected\s+package|缺少\s*package)/i,
		createFix(document, diagnostic) {
			const pkg = inferCangjiePackageFromSrcLayout(document.uri)
			if (!pkg) return undefined

			// Scan first 10 non-comment lines for package declaration.
			let hasPackage = false
			for (let i = 0; i < Math.min(10, document.lineCount); i++) {
				const l = document.lineAt(i).text.trim()
				if (!l || l.startsWith("//") || l.startsWith("/*") || l.startsWith("*")) continue
				if (l.startsWith("package ")) {
					hasPackage = true
					break
				}
				if (l.startsWith("import") || l.startsWith("class") || l.startsWith("func")) break
			}
			if (hasPackage) return undefined

			const action = new vscode.CodeAction(
				t("code_actions.cangjie_lsp.add_package", { pkg }),
				vscode.CodeActionKind.QuickFix,
			)
			action.diagnostics = [diagnostic]
			const edit = new vscode.WorkspaceEdit()
			edit.insert(document.uri, new vscode.Position(0, 0), `package ${pkg}\n\n`)
			action.edit = edit
			return action
		},
	},
]

export class CangjieCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix]

	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = []

		for (const diagnostic of context.diagnostics) {
			for (const pattern of QUICK_FIX_PATTERNS) {
				const match = diagnostic.message.match(pattern.pattern)
				if (match) {
					const action = pattern.createFix(document, diagnostic, match)
					if (action) {
						actions.push(action)
					}
				}
			}
		}

		return actions
	}
}
