import * as vscode from "vscode"
import * as path from "path"
import { CangjieSymbolIndex } from "./CangjieSymbolIndex"

// Agent-facing diagnostic root-cause trace — intentionally kept in Chinese (not i18n'd)
const CHAIN_SYM_RE =
	/(?:unknown name|undeclared|cannot find|找不到|未定义|undefined name|not found).*?['"`]([A-Za-z_][\w]*)['"`]/i

/**
 * 对「找不到符号」类连锁诊断，若符号在索引中有唯一非当前文件定义，且定义文件存在 Error 级诊断，则提示根因可能在定义文件。
 */
export function traceDiagnosticRootCause(
	diag: vscode.Diagnostic,
	diagnosticUriStr: string | undefined,
	cwd: string,
	diagnosticsByFile?: Map<string, vscode.Diagnostic[]>,
): string | null {
	if (diag.severity !== vscode.DiagnosticSeverity.Error) return null
	if (!diagnosticUriStr) return null

	let sym: string | null = null
	const m = diag.message.match(CHAIN_SYM_RE)
	if (m?.[1]) sym = m[1]
	if (!sym) {
		const m2 = diag.message.match(/\b([A-Z][A-Za-z0-9_]{1,63})\b/)
		if (
			m2?.[1] &&
			!/^(Error|Warning|String|Int32|Int64|UInt64|Float64|Bool|Unit|Nothing|Rune|Option|Array|List|Map|Set)$/.test(
				m2[1],
			)
		) {
			sym = m2[1]
		}
	}
	if (!sym) return null

	const idx = CangjieSymbolIndex.getInstance()
	if (!idx) return null

	const defs = idx.findDefinitions(sym, vscode.Uri.parse(diagnosticUriStr))
	if (defs.length !== 1) return null

	const def = defs[0]
	let diagPath: string
	try {
		diagPath = vscode.Uri.parse(diagnosticUriStr).fsPath
	} catch {
		return null
	}
	if (path.normalize(def!.filePath) === path.normalize(diagPath)) return null

	const defDiagKey = path.normalize(def!.filePath)
	const defDiags =
		diagnosticsByFile?.get(defDiagKey) ?? vscode.languages.getDiagnostics(vscode.Uri.file(def!.filePath))
	const hasErr = defDiags.some((d) => d.severity === vscode.DiagnosticSeverity.Error)
	if (!hasErr) return null

	const rel = path.relative(cwd, def!.filePath).replace(/\\/g, "/")
	const first = defDiags.find((d) => d.severity === vscode.DiagnosticSeverity.Error)
	const lineHint = first ? ` (例如第 ${first.range.start.line + 1} 行: ${first.message.slice(0, 80)}` + ")" : ""
	return `根因可能在 **${rel}**${lineHint} — 当前文件「${sym}」的连锁报错或源于定义处编译错误`
}
