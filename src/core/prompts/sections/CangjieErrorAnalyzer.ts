import * as vscode from "vscode"

import {
	CJC_DIAGNOSTIC_CODE_MAP,
	getErrorFixDirective,
	matchCjcErrorPattern,
	type CjcErrorPattern,
} from "../../../services/cangjie-lsp/CangjieErrorAnalyzer"

export function normalizeDiagnosticCode(diag: vscode.Diagnostic): string | undefined {
	const c = diag.code
	if (c === undefined || c === null) return undefined
	if (typeof c === "string" || typeof c === "number") return String(c)
	if (typeof c === "object" && c !== null && "value" in c) {
		return String((c as { value: string | number }).value)
	}
	return undefined
}

export function resolveCjcPatternForDiagnostic(diag: vscode.Diagnostic): CjcErrorPattern | null {
	const code = normalizeDiagnosticCode(diag)
	if (code) {
		const byCode = CJC_DIAGNOSTIC_CODE_MAP.get(code)
		if (byCode) return byCode
	}
	return matchCjcErrorPattern(diag.message)
}

export function buildDiagnosticPatternCache(
	diags: vscode.Diagnostic[],
): Map<vscode.Diagnostic, CjcErrorPattern | null> {
	const m = new Map<vscode.Diagnostic, CjcErrorPattern | null>()
	for (const d of diags) m.set(d, resolveCjcPatternForDiagnostic(d))
	return m
}

export function getErrorFixDirectiveForDiagnostic(diag: vscode.Diagnostic): string {
	const resolved = resolveCjcPatternForDiagnostic(diag)
	if (resolved) return resolved.suggestion
	return getErrorFixDirective(diag.message)
}
