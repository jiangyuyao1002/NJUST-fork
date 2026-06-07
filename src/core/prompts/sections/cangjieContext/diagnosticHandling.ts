// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"

import { getCangjiePromptServices } from "../cangjie-context"
import {
	normalizeDiagnosticCode as _normalizeDiagnosticCode,
	resolveCjcPatternForDiagnostic as _resolveCjcPatternForDiagnostic,
	buildDiagnosticPatternCache as _buildDiagnosticPatternCache,
} from "../CangjieErrorAnalyzer"
import { getActiveCangjieFileInfo as _getActiveCangjieFileInfo } from "../CangjieSymbolExtractor"
import { simpleHash } from "./budget"

const normalizeDiagnosticCode = _normalizeDiagnosticCode
const resolveCjcPatternForDiagnostic = _resolveCjcPatternForDiagnostic
const buildDiagnosticPatternCache = _buildDiagnosticPatternCache

const DIAGNOSTIC_URI_MAP = new WeakMap<vscode.Diagnostic, string>()

export type DiagnosticSnapshot = {
	allCjDiags: vscode.Diagnostic[]
	diagSummaryHash: number
	byFile: Map<string, vscode.Diagnostic[]>
}

export function collectDiagnosticSnapshot(): DiagnosticSnapshot {
	const allCjDiags: vscode.Diagnostic[] = []
	const byFile = new Map<string, vscode.Diagnostic[]>()
	const summaryRows: string[] = []
	for (const [uri, diags] of vscode.languages.getDiagnostics()) {
		if (!uri.fsPath.endsWith(".cj")) continue
		const key = path.normalize(uri.fsPath)
		byFile.set(key, diags)
		for (const d of diags) {
			DIAGNOSTIC_URI_MAP.set(d, uri.toString())
			allCjDiags.push(d)
			summaryRows.push(`${uri.fsPath}:${d.range.start.line}:${d.message.slice(0, 40)}`)
		}
	}
	summaryRows.sort()
	return { allCjDiags, byFile, diagSummaryHash: simpleHash(summaryRows.join("|")) }
}

const DIAG_SAMPLE_MAX_ERRORS = 15
const DIAG_SAMPLE_MAX_WARNINGS = 10

export function diagnosticTypeFingerprint(message: string): string {
	const inBackticks = message.match(/`([A-Za-z_][^`]*)`/g)
	if (inBackticks?.length) {
		return inBackticks
			.map((x) => x.slice(1, -1).replace(/\s+/g, "").toLowerCase())
			.slice(0, 4)
			.join("|")
			.slice(0, 120)
	}
	const prim = message.match(/\b(Int\d+|UInt\d+|Float\d+|Bool|String)\b/gi)
	if (prim?.length) {
		return [...new Set(prim.map((x) => x.toLowerCase()))].slice(0, 6).join("|")
	}
	return ""
}

export function normalizeDiagnosticMessageForAggregation(message: string): string {
	let s = message.replace(/\r\n/g, "\n")
	s = s.replace(/[A-Za-z]:[\\/][^:)\s]+/g, "")
	s = s.replace(/(?:\/[\w.-]+)+\.(?:cj|toml)/g, "")
	s = s.replace(/\s+/g, " ").trim()
	s = s.replace(/^\[[^\]]{1,64}\]\s*/, "")
	const fp = diagnosticTypeFingerprint(message)
	const base = s.slice(0, 180)
	return fp ? `${base}‖${fp}` : base
}

/**
 * Cap prompt-bound diagnostics: Error first, then Warning; merge identical normalized messages as "(×N)".
 * Info/Hint are omitted here to save tokens; `omitted` counts what is not covered by the sample.
 */
export function sampleCangjieDiagnostics(
	diags: vscode.Diagnostic[],
	opts?: { maxErrors?: number; maxWarnings?: number },
): { sampled: vscode.Diagnostic[]; total: number; omitted: number } {
	const maxE = opts?.maxErrors ?? DIAG_SAMPLE_MAX_ERRORS
	const maxW = opts?.maxWarnings ?? DIAG_SAMPLE_MAX_WARNINGS
	const total = diags.length

	const active = _getActiveCangjieFileInfo()
	const activeUri = vscode.window.activeTextEditor?.document.uri.toString()
	const normMemo = new Map<string, string>()
	const normAgg = (msg: string) => {
		let v = normMemo.get(msg)
		if (v === undefined) {
			v = normalizeDiagnosticMessageForAggregation(msg)
			normMemo.set(msg, v)
		}
		return v
	}
	const byBucket = new Map<string, vscode.Diagnostic[]>()
	for (const d of diags) {
		const code = normalizeDiagnosticCode(d) ?? "-"
		const key = `${d.severity}-${code}-${normAgg(d.message)}`
		const arr = byBucket.get(key)
		if (arr) arr.push(d)
		else byBucket.set(key, [d])
	}
	const patternCache = buildDiagnosticPatternCache(diags)

	const sevRank = (s: vscode.DiagnosticSeverity) =>
		s === vscode.DiagnosticSeverity.Error ? 0 : s === vscode.DiagnosticSeverity.Warning ? 1 : 2

	const patternPri = (d: vscode.Diagnostic) => patternCache.get(d)?.priority ?? 0

	const bucketsWithMin = [...byBucket.values()].map((group) => ({
		group,
		minLine: group.reduce((m, x) => Math.min(m, x.range.start.line), Number.MAX_SAFE_INTEGER),
	}))
	bucketsWithMin.sort((ba, bb) => {
		const a = ba.group
		const b = bb.group
		const da = a[0]!
		const db = b[0]!
		const r = sevRank(da.severity) - sevRank(db.severity)
		if (r !== 0) return r
		const pa = patternPri(da)
		const pb = patternPri(db)
		if (Math.abs(pa - pb) >= 10) return pb - pa
		const pr = pb - pa
		if (pr !== 0) return pr
		const la = ba.minLine
		const lb = bb.minLine
		if (!active || !activeUri) return la - lb
		const uriA = DIAGNOSTIC_URI_MAP.get(da)
		const uriB = DIAGNOSTIC_URI_MAP.get(db)
		const distA = uriA === activeUri ? Math.abs(la - active.cursorLine) : Number.MAX_SAFE_INTEGER / 2 + la
		const distB = uriB === activeUri ? Math.abs(lb - active.cursorLine) : Number.MAX_SAFE_INTEGER / 2 + lb
		return distA - distB
	})
	const buckets = bucketsWithMin.map((x) => x.group)

	const sampled: vscode.Diagnostic[] = []
	let errTaken = 0
	let warnTaken = 0
	let covered = 0

	for (const group of buckets) {
		const rep = group[0]!
		if (rep.severity === vscode.DiagnosticSeverity.Error) {
			if (errTaken >= maxE) continue
			errTaken++
		} else if (rep.severity === vscode.DiagnosticSeverity.Warning) {
			if (warnTaken >= maxW) continue
			warnTaken++
		} else {
			continue
		}

		covered += group.length
		if (group.length === 1) {
			sampled.push(rep)
		} else {
			const lines = [...new Set(group.map((g) => g.range.start.line + 1))].sort((a, b) => a - b)
			const lineHint =
				lines.length > 0 ? ` @ line ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? ", ..." : ""}` : ""
			const clone = new vscode.Diagnostic(rep.range, `${rep.message} (×${group.length}${lineHint})`, rep.severity)
			clone.code = rep.code
			clone.source = rep.source
			clone.relatedInformation = rep.relatedInformation
			clone.tags = rep.tags
			const repUri = DIAGNOSTIC_URI_MAP.get(rep)
			if (repUri) DIAGNOSTIC_URI_MAP.set(clone, repUri)
			sampled.push(clone)
		}
	}

	return { sampled, total, omitted: total - covered }
}

/**
 * Map diagnostic messages to error patterns and documentation.
 */
const CONVERSION_HINT_MSG_RE = /mismatch|不匹配|类型|type|expected|需要/

export function buildConversionHintByMessage(diagnostics: vscode.Diagnostic[]): Map<string, string | undefined> {
	const idx = getCangjiePromptServices().getCangjieSymbolIndex()
	const map = new Map<string, string | undefined>()
	if (!idx) return map
	for (const d of diagnostics) {
		if (!CONVERSION_HINT_MSG_RE.test(d.message)) continue
		if (map.has(d.message)) continue
		map.set(d.message, idx.getConversionHintFromDiagnosticMessage(d.message) ?? undefined)
	}
	return map
}

export function mapDiagnosticsToDocContext(
	diagnostics: vscode.Diagnostic[],
	docsBase: string,
	conversionByMessage: Map<string, string | undefined>,
): string[] {
	const matchedCategories = new Set<string>()
	const sections: string[] = []

	for (const diag of diagnostics) {
		const pattern = resolveCjcPatternForDiagnostic(diag)
		if (pattern && !matchedCategories.has(pattern.category)) {
			matchedCategories.add(pattern.category)
			const docPathsStr = pattern.docPaths.map((p) => path.join(docsBase, p).replace(/\\/g, "/")).join(", ")
			const codeStr = normalizeDiagnosticCode(diag)
			const codeNote = codeStr ? ` (code: ${codeStr})` : ""
			let line = `- **${pattern.category}**${codeNote}: ${pattern.suggestion}\n  参考文档: ${docPathsStr}`
			if (CONVERSION_HINT_MSG_RE.test(diag.message)) {
				const conv = conversionByMessage.get(diag.message)
				if (conv) line += `\n  ${conv}`
			}
			sections.push(line)
		}
	}

	return sections
}

export function buildDiagnosticAugmentationLines(
	diagnostics: vscode.Diagnostic[],
	cwd: string,
	conversionByMessage: Map<string, string | undefined>,
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
): string[] {
	const lines: string[] = []
	const seen = new Set<string>()
	for (const d of diagnostics) {
		const uri = DIAGNOSTIC_URI_MAP.get(d)
		const root = getCangjiePromptServices()
			.getCangjieDiagnosticRootCause()
			.traceDiagnosticRootCause(d, uri, cwd, diagnosticsByFile)
		if (root && !seen.has(root)) {
			seen.add(root)
			lines.push(`- ${root}`)
		}
		if (CONVERSION_HINT_MSG_RE.test(d.message)) {
			const conv = conversionByMessage.get(d.message)
			if (conv && !seen.has(`c:${conv}`)) {
				seen.add(`c:${conv}`)
				lines.push(`- ${conv}`)
			}
		}
	}
	return lines
}
