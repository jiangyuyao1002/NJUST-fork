import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { parse as parseToml } from "smol-toml"
import { NJUST_AI_CONFIG_DIR } from "@njust-ai-cj/types"
import { Package } from "../../../shared/package"
import { getCjpmTreeSummaryForPrompt } from "../../../services/cangjie-lsp/cjpmTreeForPrompt"
import {
	parseCangjieDefinitions,
	computeCangjieSignature,
	type CangjieDef,
} from "../../../services/tree-sitter/cangjieParser"
import { CangjieSymbolIndex, type SymbolEntry } from "../../../services/cangjie-lsp/CangjieSymbolIndex"
import { getBundledCangjieCorpusPath } from "../../../utils/bundledCangjieCorpus"
import { CangjieCorpusSemanticIndex } from "../../../services/cangjie-corpus/CangjieCorpusSemanticIndex"
import {
	formatCompileHistoryPromptSection,
	getCompileHistoryRevision,
} from "../../../services/cangjie-lsp/cangjieCompileHistory"
import type { CangjieContextIntensity } from "../../task/CangjieRuntimePolicy"
import { LIMITS } from "../../../shared/constants"

let corpusSingleton: { instance: CangjieCorpusSemanticIndex; root: string } | null = null

function getCorpusSingleton(corpusRoot: string): CangjieCorpusSemanticIndex {
	if (corpusSingleton && corpusSingleton.root === corpusRoot) {
		return corpusSingleton.instance
	}
	const instance = new CangjieCorpusSemanticIndex(corpusRoot)
	corpusSingleton = { instance, root: corpusRoot }
	return instance
}
import {
	CJC_ERROR_PATTERNS as _CJC_ERROR_PATTERNS,
	STDLIB_DOC_MAP as _STDLIB_DOC_MAP,
	getErrorFixDirective as _getErrorFixDirective,
	getMatchingCjcPatternsByCategory,
	matchCjcErrorPattern,
	type CjcErrorPattern,
	type DocMapping,
} from "../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import {
	LEARNED_FIXES_FILE,
	LEARNED_FIXES_MAX_PATTERNS,
	type LearnedFixPattern,
	getLearnedFixesFileMtime,
	loadLearnedFixes,
	saveLearnedFixes,
} from "./learnedFixesStorage"
import { traceDiagnosticRootCause } from "../../../services/cangjie-lsp/cangjieDiagnosticRootCause"
import { mergeStdlibConstraintHintsFromCorpus } from "../../../services/cangjie-lsp/stdlibConstraintHints"

import {
	normalizeDiagnosticCode as _normalizeDiagnosticCode,
	resolveCjcPatternForDiagnostic as _resolveCjcPatternForDiagnostic,
	buildDiagnosticPatternCache as _buildDiagnosticPatternCache,
	getErrorFixDirectiveForDiagnostic as _getErrorFixDirectiveForDiagnostic,
} from "./CangjieErrorAnalyzer"
import {
	extractImports as _extractImports,
	mapImportsToDocPaths as _mapImportsToDocPaths,
	resolveImportedSymbols as _resolveImportedSymbols,
	resolveImportToDirectory as _resolveImportToDirectory,
	isNonTrivialImportMapping as _isNonTrivialImportMapping,
	extractTypeOutlineFromLines as _extractTypeOutlineFromLines,
	formatSymbolEntries as _formatSymbolEntries,
} from "./CangjieDependencyResolver"
import {
	collectActiveCangjieEditorSnapshot as _collectActiveCangjieEditorSnapshot,
	getActiveCangjieFileInfo as _getActiveCangjieFileInfo,
	type StructuredEditingContextPreparse,
} from "./CangjieSymbolExtractor"

const LEARNED_FIXES_MAX_SECTION_CHARS = 4000

const PACKAGE_DECL_REGEX = /^\s*package\s+([\w.]+)\s*$/m

// Re-import from analyzer (single source of truth for error patterns / doc mappings)
const STDLIB_DOC_MAP = _STDLIB_DOC_MAP
const CJC_ERROR_PATTERNS = _CJC_ERROR_PATTERNS

/** Keywords derived from error pattern categories/suggestions — lower learned-fix similarity threshold when both sides hit */
const LEARNED_FIX_CATEGORY_LEXICON: Set<string> = (() => {
	const s = new Set<string>()
	for (const p of CJC_ERROR_PATTERNS) {
		for (const part of p.category.split(/[/／、,，\s]+/)) {
			const w = part.trim().toLowerCase()
			if (w.length >= 2) s.add(w)
		}
		const sug = p.suggestion.toLowerCase().replace(/\s+/g, " ")
		for (const word of sug.split(/[\s,，。]+/)) {
			if (word.length >= 2 && /[\u4e00-\u9fff]/.test(word)) s.add(word)
			if (word.length > 4 && /^[a-z][a-z-]+$/.test(word)) s.add(word)
		}
	}
	return s
})()

const normalizeDiagnosticCode = _normalizeDiagnosticCode
const resolveCjcPatternForDiagnostic = _resolveCjcPatternForDiagnostic
const buildDiagnosticPatternCache = _buildDiagnosticPatternCache
const getErrorFixDirectiveForDiagnostic = _getErrorFixDirectiveForDiagnostic

// SYNTAX_PITFALLS and CODE_REVIEW_CHECKLIST have been removed to avoid
// duplication with the inlined CANGJIE_SYNTAX_REFERENCE and CANGJIE_CODING_RULES
// that are already injected via customInstructions in mode.ts.

// ---------------------------------------------------------------------------
// Project structure types and constants
// ---------------------------------------------------------------------------

interface CjpmProjectInfo {
	name: string
	version: string
	outputType: string
	isWorkspace: boolean
	members?: Array<{
		name: string
		path: string
		outputType: string
		dependencies?: Record<string, { path?: string; git?: string; tag?: string; branch?: string }>
		dependencyDisplay?: string[]
	}>
	dependencies?: Record<string, { path?: string; git?: string; tag?: string; branch?: string }>
	srcDir: string
}

type WorkspaceMember = NonNullable<CjpmProjectInfo["members"]>[number]

interface PackageNode {
	packageName: string
	dirPath: string
	sourceFiles: string[]
	testFiles: string[]
	hasMain: boolean
	children: PackageNode[]
}

const MAX_SCAN_DEPTH = 5
const MAX_SCAN_FILES = 500
const MAX_WORKSPACE_MEMBERS = 20

const CONTEXT_FILE_LRU_MAX = 64
const contextFileLru = new Map<string, { mtime: number; text: string }>()

function readFileUtf8Lru(fp: string): string | null {
	try {
		const st = fs.statSync(fp)
		const hit = contextFileLru.get(fp)
		if (hit && hit.mtime === st.mtimeMs) return hit.text
		const text = fs.readFileSync(fp, "utf-8")
		if (contextFileLru.size >= CONTEXT_FILE_LRU_MAX) {
			const first = contextFileLru.keys().next().value as string | undefined
			if (first !== undefined) contextFileLru.delete(first)
		}
		contextFileLru.set(fp, { mtime: st.mtimeMs, text })
		return text
	} catch {
		return null
	}
}

function editorDocumentCacheKey(uri: vscode.Uri): string {
	const fp = uri.fsPath
	if (uri.scheme !== "file") return fp
	try {
		return `${fp}:${fs.statSync(fp).mtimeMs}`
	} catch {
		return fp
	}
}

// ---------------------------------------------------------------------------
// Cross-file symbol resolution via CangjieSymbolIndex
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Source-level package declaration verification
// ---------------------------------------------------------------------------

/**
 * Read actual `package` declarations from .cj source files and compare
 * with directory-inferred package names. Report mismatches so the AI
 * can generate correct package declarations.
 */
function verifyPackageDeclarations(
	root: PackageNode,
	cwd: string,
	srcDir: string,
): string | null {
	const mismatches: string[] = []
	const MAX_CHECKS = 50
	let checked = 0
	const symbolIndex = CangjieSymbolIndex.getInstance()

	function walk(node: PackageNode): void {
		if (checked >= MAX_CHECKS) return

		for (const fileName of node.sourceFiles) {
			if (checked >= MAX_CHECKS) return
			checked++

			const filePath = path.join(cwd, node.dirPath, fileName)
			const expectedPkg = node.packageName
			let declaredPkg: string | null = null

			// Prefer SymbolIndex (no file I/O) over fs.readFileSync
			if (symbolIndex) {
				const syms = symbolIndex.getSymbolsByFile(filePath)
				const pkgSym = syms.find((s) => s.kind === "package")
				if (pkgSym) declaredPkg = pkgSym.name
			}

			// Fallback: read from disk (SymbolIndex may not include package entries)
			if (declaredPkg === null) {
				try {
					const content = fs.readFileSync(filePath, "utf-8")
					const match = content.match(PACKAGE_DECL_REGEX)
					declaredPkg = match ? match[1] : null
				} catch {
					continue
				}
			}

			if (declaredPkg && declaredPkg !== expectedPkg) {
				const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
				mismatches.push(
					`- ${relPath}: 声明 \`package ${declaredPkg}\`，但目录推导应为 \`package ${expectedPkg}\``,
				)
			} else if (!declaredPkg && node.packageName.includes(".")) {
				const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
				mismatches.push(
					`- ${relPath}: **缺少 package 声明**，应声明 \`package ${expectedPkg}\``,
				)
			}
		}

		for (const child of node.children) {
			walk(child)
		}
	}

	walk(root)

	if (mismatches.length === 0) return null

	return (
		`## ⚠ 包声明不一致\n\n` +
		`以下文件的 \`package\` 声明与目录结构不匹配，**生成代码时请使用正确的包名**：\n\n` +
		mismatches.join("\n") +
		`\n\n规则: 文件所在目录相对于 ${srcDir}/ 的路径决定包名（如 ${srcDir}/network/http/ → package <root>.network.http）`
	)
}

// ---------------------------------------------------------------------------
// Workspace cross-module symbol summary
// ---------------------------------------------------------------------------

/**
 * For workspace projects, generate a summary of public symbols in each
 * member module so the AI knows what's available across modules.
 */
function buildWorkspaceSymbolSummary(
	info: CjpmProjectInfo,
	cwd: string,
): string | null {
	if (!info.isWorkspace || !info.members || info.members.length === 0) return null

	const symbolIndex = CangjieSymbolIndex.getInstance()
	if (!symbolIndex || symbolIndex.symbolCount === 0) return null

	const MAX_SYMBOLS_PER_MODULE = 20
	const moduleSections: string[] = []

	for (const member of info.members) {
		const memberSrcDir = path.join(cwd, member.path, "src")
		if (!fs.existsSync(memberSrcDir)) continue

		const symbols = symbolIndex.getSymbolsByDirectory(memberSrcDir)
		if (symbols.length === 0) continue

		const topLevel = symbols
			.filter((s) => ["class", "struct", "interface", "enum", "func", "type"].includes(s.kind))
			.slice(0, MAX_SYMBOLS_PER_MODULE)

		if (topLevel.length === 0) continue

		const lines = topLevel.map((s) => {
			const vis = s.visibility && s.visibility !== "internal" ? `${s.visibility} ` : ""
			const tp = s.typeParams ? `${s.typeParams} ` : ""
			const sig = s.signature ? `: \`${s.signature}\`` : ""
			return `  - ${vis}${s.kind} ${tp}**${s.name}**${sig}`
		})

		const suffix = symbols.length > MAX_SYMBOLS_PER_MODULE
			? `\n  - _…共 ${symbols.length} 个符号_`
			: ""

		moduleSections.push(`- **${member.name}** (${member.outputType}):\n${lines.join("\n")}${suffix}`)
	}

	if (moduleSections.length === 0) return null

	return (
		`## 工作区各模块公共符号\n\n` +
		`以下是各模块的主要类型和函数定义，跨模块引用时需确保目标符号为 public 并在 cjpm.toml 中声明依赖：\n\n` +
		moduleSections.join("\n\n")
	)
}

/**
 * Collect current cjlint/cjc diagnostics from VS Code.
 */
const DIAGNOSTIC_URI_MAP = new WeakMap<vscode.Diagnostic, string>()

type DiagnosticSnapshot = {
	allCjDiags: vscode.Diagnostic[]
	diagSummaryHash: number
	byFile: Map<string, vscode.Diagnostic[]>
}

function collectDiagnosticSnapshot(): DiagnosticSnapshot {
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

function diagnosticTypeFingerprint(message: string): string {
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
		return [...new Set(prim.map((x) => x.toLowerCase()))]
			.slice(0, 6)
			.join("|")
	}
	return ""
}

function normalizeDiagnosticMessageForAggregation(message: string): string {
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
function sampleCangjieDiagnostics(
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
		const da = a[0]
		const db = b[0]
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
		const rep = group[0]
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
			const lineHint = lines.length > 0 ? ` @ line ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? ", ..." : ""}` : ""
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

function buildConversionHintByMessage(diagnostics: vscode.Diagnostic[]): Map<string, string | undefined> {
	const idx = CangjieSymbolIndex.getInstance()
	const map = new Map<string, string | undefined>()
	if (!idx) return map
	for (const d of diagnostics) {
		if (!CONVERSION_HINT_MSG_RE.test(d.message)) continue
		if (map.has(d.message)) continue
		map.set(d.message, idx.getConversionHintFromDiagnosticMessage(d.message) ?? undefined)
	}
	return map
}

function mapDiagnosticsToDocContext(
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
			const docPathsStr = pattern.docPaths
				.map((p) => path.join(docsBase, p).replace(/\\/g, "/"))
				.join(", ")
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

function buildDiagnosticAugmentationLines(
	diagnostics: vscode.Diagnostic[],
	cwd: string,
	conversionByMessage: Map<string, string | undefined>,
	diagnosticsByFile: Map<string, vscode.Diagnostic[]>,
): string[] {
	const lines: string[] = []
	const seen = new Set<string>()
	for (const d of diagnostics) {
		const uri = DIAGNOSTIC_URI_MAP.get(d)
		const root = traceDiagnosticRootCause(d, uri, cwd, diagnosticsByFile)
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

export function resolveBundledCangjieCorpusPath(extensionPath: string | undefined): string | null {
	return getBundledCangjieCorpusPath(extensionPath)
}

/**
 * Resolve the Cangjie documentation / corpus root.
 * **Only** the extension-bundled tree (`bundled-cangjie-corpus/CangjieCorpus-1.0.0`). No workspace or `.njust_ai` fallbacks.
 */
export function resolveCangjieDocsBasePath(extensionPath?: string): string | null {
	return resolveBundledCangjieCorpusPath(extensionPath)
}

const STYLE_FEW_SHOT_MAX_CHARS = 2200
const STYLE_SNIPPET_LINES = 16
const STYLE_FEW_SHOT_CACHE_TTL_MS = 30_000
const STYLE_FEW_SHOT_MAX_PER_MODULE = 1

let styleFewShotCache: { key: string; value: string | null; time: number } | null = null

type CjpmTomlMetaCacheEntry = { mtimeMs: number; value: { info: CjpmProjectInfo | null; cjpmRawHash: string }; time: number }
const cjpmTomlMetaCache = new Map<string, CjpmTomlMetaCacheEntry>()

function topLevelModuleFromRel(rel: string): string {
	const normalized = rel.replace(/\\/g, "/")
	const segs = normalized.split("/")
	if (segs.length < 2) return normalized
	if (segs[0] === "src" && segs.length >= 3) return segs[1]
	return segs[0]
}

function buildCangjieStyleFewShotSection(
	cwd: string,
	imports: string[],
	diagnostics: vscode.Diagnostic[],
	cjpmRawHash: string,
): string | null {
	const idx = CangjieSymbolIndex.getInstance()
	if (!idx || idx.symbolCount === 0) return null
	const learnedData = loadLearnedFixes(cwd)
	const learnedMtime = getLearnedFixesFileMtime(cwd)
	const cacheKey = [
		cwd,
		cjpmRawHash,
		`idx:${idx.fileCount}:${idx.symbolCount}`,
		`imp:${imports.slice(0, 8).join("|")}`,
		`lf:${learnedMtime}:${learnedData.patterns.length}`,
		`diag:${diagnostics
			.map((d) => normalizeDiagnosticCode(d) ?? normalizeDiagnosticMessageForAggregation(d.message))
			.slice(0, 6)
			.join("|")}`,
	].join("::")
	const now = Date.now()
	if (styleFewShotCache && styleFewShotCache.key === cacheKey && now - styleFewShotCache.time < STYLE_FEW_SHOT_CACHE_TTL_MS) {
		return styleFewShotCache.value
	}

	const header =
		"## 工作区代码风格样本（few-shot）\n\n从符号索引中选取的代表性片段，新建代码时请保持相近风格与命名习惯：\n\n"
	let used = header.length
	const picked: string[] = []
	const kinds = new Set(["func", "class", "struct"])

	const ranked = idx
		.getAllSymbols()
		.filter((s) => kinds.has(s.kind))
		.sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
	const byFile = new Map<string, SymbolEntry>()
	for (const s of ranked) {
		const prev = byFile.get(s.filePath)
		const span = s.endLine - s.startLine
		if (!prev || span > prev.endLine - prev.startLine) byFile.set(s.filePath, s)
	}
	const candidates = [...byFile.values()]
		.sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
		.slice(0, 10)

	const scored: Array<{ score: number; rel: string; block: string }> = []
	const fileCache = new Map<string, string[]>()
	const activeImportSet = new Set(imports)
	const diagMessage = diagnostics.map((d) => d.message.toLowerCase()).join(" ")
	const wantsTypeFix = /type|类型|mismatch|转换/.test(diagMessage)
	const diagKeywords = new Set<string>()
	for (const d of diagnostics) {
		const agg = normalizeDiagnosticMessageForAggregation(d.message).toLowerCase()
		for (const w of agg.split(/[\s,.:;，。]+/).filter((x) => x.length > 2)) {
			diagKeywords.add(w)
		}
	}
	const matchedLearnedPatterns = learnedData.patterns.filter((p) => learnedPatternMatchesDiagnostics(p, diagnostics))
	for (const sym of candidates) {
		const sigLen = sym.signature.length
		const span = sym.endLine - sym.startLine + 1
		let score = sigLen + span * 8
		try {
			let lines = fileCache.get(sym.filePath)
			if (!lines) {
				const raw = readFileUtf8Lru(sym.filePath)
				if (!raw) continue
				lines = raw.split("\n")
				fileCache.set(sym.filePath, lines)
			}
			const fullText = lines.join("\n")
			const symbolImports = _extractImports(fullText)
			const importOverlap = symbolImports.filter((imp) => activeImportSet.has(imp)).length
			score += importOverlap * 60
			const rel = path.relative(cwd, sym.filePath).replace(/\\/g, "/")
			for (const p of matchedLearnedPatterns) {
				const fix = (p.fix ?? "").replace(/\\/g, "/")
				if (fix.includes(rel) || fix.includes(path.basename(sym.filePath))) {
					score += 150
					break
				}
			}
			let kwBonus = 0
			const lowerFull = fullText.toLowerCase()
			for (const w of diagKeywords) {
				if (w.length < 3) continue
				if (lowerFull.includes(w)) {
					kwBonus += 80
					if (kwBonus >= 240) break
				}
			}
			score += kwBonus
			if (wantsTypeFix && /(as\s+|to\w+\(|parse|tryParse)/.test(fullText)) {
				score += 40
			}
			const from = sym.startLine
			const to = Math.min(sym.endLine, sym.startLine + STYLE_SNIPPET_LINES - 1)
			const slice = lines.slice(from, to + 1).join("\n")
			if (slice.trim().length < 24) continue
			const block =
				"```cangjie\n" +
				`// ${sym.kind} ${sym.name} (${rel}:${from + 1})\n` +
				slice +
				"\n```"
			scored.push({ score, rel, block })
		} catch {
			/* skip */
		}
	}

	scored.sort((a, b) => b.score - a.score)
	const seenRel = new Set<string>()
	const moduleCount = new Map<string, number>()
	for (const s of scored) {
		if (picked.length >= 3) break
		if (seenRel.has(s.rel)) continue
		const topModule = topLevelModuleFromRel(s.rel)
		const count = moduleCount.get(topModule) ?? 0
		if (count >= STYLE_FEW_SHOT_MAX_PER_MODULE) continue
		seenRel.add(s.rel)
		if (used + s.block.length + 2 > STYLE_FEW_SHOT_MAX_CHARS) break
		picked.push(s.block)
		moduleCount.set(topModule, count + 1)
		used += s.block.length + 2
	}

	if (picked.length === 0) {
		styleFewShotCache = { key: cacheKey, value: null, time: now }
		return null
	}
	const value = `${header}${picked.join("\n\n")}`
	styleFewShotCache = { key: cacheKey, value, time: now }
	return value
}

// ---------------------------------------------------------------------------
// cjpm.toml parsing
// ---------------------------------------------------------------------------

function splitTomlSections(content: string): Map<string, string> {
	const sections = new Map<string, string>()
	const lines = content.split("\n")
	let currentSection = ""
	let currentLines: string[] = []

	for (const line of lines) {
		const match = line.match(/^\s*\[([^\]]+)\]\s*$/)
		if (match) {
			if (currentSection) {
				sections.set(currentSection, currentLines.join("\n"))
			}
			currentSection = match[1].trim()
			currentLines = []
		} else {
			currentLines.push(line)
		}
	}

	if (currentSection) {
		sections.set(currentSection, currentLines.join("\n"))
	}

	return sections
}

function extractTomlString(section: string, key: string): string | undefined {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const re = new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"`, "m")
	const match = section.match(re)
	return match ? match[1] : undefined
}

function extractTomlArray(section: string, key: string): string[] {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const re = new RegExp(`^\\s*${escaped}\\s*=\\s*\\[([^\\]]*)\\]`, "ms")
	const match = section.match(re)
	if (!match) return []
	return match[1].match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) || []
}

function extractTomlInlineTables(section: string): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {}
	const re = /^\s*(\S+)\s*=\s*\{([^}]*)\}\s*$/gm
	let match
	while ((match = re.exec(section)) !== null) {
		const key = match[1].trim()
		const tableContent = match[2]
		const table: Record<string, string> = {}
		const kvRe = /([\w][\w-]*)\s*=\s*"([^"]*)"/g
		let kvMatch
		while ((kvMatch = kvRe.exec(tableContent)) !== null) {
			table[kvMatch[1]] = kvMatch[2]
		}
		result[key] = table
	}
	return result
}

function parseSingleModuleProject(sections: Map<string, string>): CjpmProjectInfo | null {
	const pkg = sections.get("package")
	if (!pkg) return null

	const name = extractTomlString(pkg, "name") || ""
	const version = extractTomlString(pkg, "version") || ""
	const outputType = extractTomlString(pkg, "output-type") || "executable"
	const srcDir = extractTomlString(pkg, "src-dir") || "src"

	let dependencies: CjpmProjectInfo["dependencies"]
	const deps = sections.get("dependencies")
	if (deps) {
		const tables = extractTomlInlineTables(deps)
		if (Object.keys(tables).length > 0) {
			dependencies = {}
			for (const [depName, t] of Object.entries(tables)) {
				dependencies[depName] = { path: t["path"], git: t["git"], tag: t["tag"], branch: t["branch"] }
			}
		}
	}

	return { name, version, outputType, isWorkspace: false, srcDir, dependencies }
}

function tomStr(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== "object") return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === "string" ? v : undefined
}

function tomDepsFromObject(tbl: unknown): CjpmProjectInfo["dependencies"] | undefined {
	if (!tbl || typeof tbl !== "object" || Array.isArray(tbl)) return undefined
	const out: NonNullable<CjpmProjectInfo["dependencies"]> = {}
	for (const [depName, val] of Object.entries(tbl as Record<string, unknown>)) {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const t = val as Record<string, unknown>
			out[depName] = {
				path: typeof t.path === "string" ? t.path : undefined,
				git: typeof t.git === "string" ? t.git : undefined,
				tag: typeof t.tag === "string" ? t.tag : undefined,
				branch: typeof t.branch === "string" ? t.branch : undefined,
			}
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function buildDependencyDisplay(
	deps: CjpmProjectInfo["dependencies"] | undefined,
): string[] | undefined {
	if (!deps || Object.keys(deps).length === 0) return undefined
	const rows = Object.entries(deps).map(([d, t]) => {
		if (t.path) return `${d}(path:${t.path})`
		if (t.git) return `${d}(git)`
		if (t.tag) return `${d}(tag:${t.tag})`
		if (t.branch) return `${d}(branch:${t.branch})`
		return d
	})
	return rows.length > 0 ? rows : undefined
}

async function parseMemberCjpmIntoWorkspaceMember(memberRoot: string, pathRel: string): Promise<WorkspaceMember | null> {
	const memberToml = path.join(memberRoot, "cjpm.toml")
	let content: string
	try {
		content = await fs.promises.readFile(memberToml, "utf-8")
	} catch {
		return null
	}
	try {
		const root = parseToml(content) as Record<string, unknown>
		const pkg = root.package
		if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
			const memberDeps = tomDepsFromObject(root.dependencies)
			return {
				name: tomStr(pkg, "name") || path.basename(pathRel),
				path: pathRel,
				outputType: tomStr(pkg, "output-type") || "static",
				dependencies: memberDeps,
				dependencyDisplay: buildDependencyDisplay(memberDeps),
			}
		}
	} catch {
		/* member smol-toml failed */
	}
	try {
		const ms = splitTomlSections(content)
		const pkg = ms.get("package")
		if (!pkg) return null
		let memberDeps: WorkspaceMember["dependencies"]
		const depSec = ms.get("dependencies")
		if (depSec) {
			const tables = extractTomlInlineTables(depSec)
			if (Object.keys(tables).length > 0) {
				memberDeps = {}
				for (const [depName, t] of Object.entries(tables)) {
					memberDeps[depName] = { path: t["path"], git: t["git"], tag: t["tag"], branch: t["branch"] }
				}
			}
		}
		return {
			name: extractTomlString(pkg, "name") || path.basename(pathRel),
			path: pathRel,
			outputType: extractTomlString(pkg, "output-type") || "static",
			dependencies: memberDeps,
			dependencyDisplay: buildDependencyDisplay(memberDeps),
		}
	} catch {
		return null
	}
}

async function projectInfoFromParsedTomlRoot(root: Record<string, unknown>, cwd: string): Promise<CjpmProjectInfo | null> {
	const ws = root.workspace
	if (ws && typeof ws === "object" && !Array.isArray(ws)) {
		const membersRaw = (ws as Record<string, unknown>).members
		const memberPaths = Array.isArray(membersRaw)
			? membersRaw.filter((x): x is string => typeof x === "string")
			: []
		const slice = memberPaths.slice(0, MAX_WORKSPACE_MEMBERS)
		const resolved = await Promise.all(slice.map((mp) => parseMemberCjpmIntoWorkspaceMember(path.join(cwd, mp), mp)))
		const members = resolved.filter((m): m is WorkspaceMember => m != null)
		const dependencies = tomDepsFromObject(root.dependencies)
		return { name: "", version: "", outputType: "", isWorkspace: true, members, dependencies, srcDir: "src" }
	}
	const pkg = root.package
	if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
		const name = tomStr(pkg, "name") || ""
		const version = tomStr(pkg, "version") || ""
		const outputType = tomStr(pkg, "output-type") || "executable"
		const srcDir = tomStr(pkg, "src-dir") || "src"
		const dependencies = tomDepsFromObject(root.dependencies)
		return { name, version, outputType, isWorkspace: false, srcDir, dependencies }
	}
	return null
}

async function parseWorkspaceProjectRegexAsync(sections: Map<string, string>, cwd: string): Promise<CjpmProjectInfo | null> {
	const ws = sections.get("workspace")
	if (!ws) return null
	const memberPaths = extractTomlArray(ws, "members")
	const slice = memberPaths.slice(0, MAX_WORKSPACE_MEMBERS)
	const resolved = await Promise.all(slice.map((mp) => parseMemberCjpmIntoWorkspaceMember(path.join(cwd, mp), mp)))
	const members = resolved.filter((m): m is WorkspaceMember => m != null)
	let dependencies: CjpmProjectInfo["dependencies"]
	const deps = sections.get("dependencies")
	if (deps) {
		const tables = extractTomlInlineTables(deps)
		if (Object.keys(tables).length > 0) {
			dependencies = {}
			for (const [depName, t] of Object.entries(tables)) {
				dependencies[depName] = { path: t["path"], git: t["git"] }
			}
		}
	}
	return { name: "", version: "", outputType: "", isWorkspace: true, members, dependencies, srcDir: "src" }
}

async function parseCjpmTomlContent(content: string, cwd: string): Promise<CjpmProjectInfo | null> {
	try {
		const root = parseToml(content) as Record<string, unknown>
		const fromSmol = await projectInfoFromParsedTomlRoot(root, cwd)
		if (fromSmol) return fromSmol
	} catch (e) {
		console.warn("[cangjie-context] smol-toml parse failed, using regex fallback:", e)
	}
	try {
		const sections = splitTomlSections(content)
		if (sections.has("workspace")) {
			return await parseWorkspaceProjectRegexAsync(sections, cwd)
		}
		if (sections.has("package")) {
			return parseSingleModuleProject(sections)
		}
	} catch {
		/* ignore parse errors */
	}
	return null
}

async function parseCjpmTomlWithMeta(cwd: string): Promise<{ info: CjpmProjectInfo | null; cjpmRawHash: string }> {
	const tomlPath = path.join(cwd, "cjpm.toml")
	const now = Date.now()
	try {
		const st = await fs.promises.stat(tomlPath)
		const cached = cjpmTomlMetaCache.get(cwd)
		if (cached && cached.mtimeMs === st.mtimeMs && now - cached.time < PROJECT_OVERVIEW_CACHE_TTL_MS) {
			return cached.value
		}
		const content = await fs.promises.readFile(tomlPath, "utf-8")
		const info = await parseCjpmTomlContent(content, cwd)
		const value = { info, cjpmRawHash: String(simpleHash(content)) }
		cjpmTomlMetaCache.set(cwd, { mtimeMs: st.mtimeMs, value, time: now })
		if (cjpmTomlMetaCache.size > 64) {
			const first = cjpmTomlMetaCache.keys().next().value as string | undefined
			if (first !== undefined) cjpmTomlMetaCache.delete(first)
		}
		return value
	} catch {
		return { info: null, cjpmRawHash: "no-cjpm" }
	}
}

async function parseCjpmToml(cwd: string): Promise<CjpmProjectInfo | null> {
	const { info } = await parseCjpmTomlWithMeta(cwd)
	return info
}

// ---------------------------------------------------------------------------
// Package hierarchy scanning
// ---------------------------------------------------------------------------

const PACKAGE_TREE_CACHE_TTL_MS = 60_000
const packageTreeCache = new Map<string, { value: PackageNode | null; time: number }>()

function getPackageTreeCacheKey(cwd: string, srcDir: string, rootPackageName?: string): string {
	return `${cwd}|${srcDir}|${rootPackageName ?? "default"}`
}

function getCachedPackageHierarchy(cwd: string, srcDir: string, rootPackageName?: string): PackageNode | null {
	const key = getPackageTreeCacheKey(cwd, srcDir, rootPackageName)
	const now = Date.now()
	const hit = packageTreeCache.get(key)
	if (hit && now - hit.time < PACKAGE_TREE_CACHE_TTL_MS) return hit.value
	const value = scanPackageHierarchy(cwd, srcDir, rootPackageName)
	packageTreeCache.set(key, { value, time: now })
	if (packageTreeCache.size > 128) {
		const first = packageTreeCache.keys().next().value as string | undefined
		if (first !== undefined) packageTreeCache.delete(first)
	}
	return value
}

function scanPackageHierarchy(cwd: string, srcDir: string, rootPackageName?: string): PackageNode | null {
	const srcPath = path.join(cwd, srcDir)
	if (!fs.existsSync(srcPath)) return null

	let fileCount = 0
	const rootPkg = rootPackageName || "default"

	function scan(dir: string, depth: number, pkgName: string): PackageNode | null {
		if (depth > MAX_SCAN_DEPTH || fileCount > MAX_SCAN_FILES) return null

		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return null
		}

		const sourceFiles: string[] = []
		const testFiles: string[] = []
		let hasMain = false
		const childDirs: fs.Dirent[] = []

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".cj")) {
				fileCount++
				if (entry.name.endsWith("_test.cj")) {
					testFiles.push(entry.name)
				} else {
					sourceFiles.push(entry.name)
					if (entry.name === "main.cj") hasMain = true
				}
			} else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "target") {
				childDirs.push(entry)
			}
		}

		const children: PackageNode[] = []
		for (const cd of childDirs) {
			const childNode = scan(path.join(dir, cd.name), depth + 1, `${pkgName}.${cd.name}`)
			if (childNode) children.push(childNode)
		}

		if (sourceFiles.length === 0 && testFiles.length === 0 && children.length === 0) return null

		return {
			packageName: pkgName,
			dirPath: path.relative(cwd, dir).replace(/\\/g, "/"),
			sourceFiles,
			testFiles,
			hasMain,
			children,
		}
	}

	return scan(srcPath, 0, rootPkg)
}

function countTreeFiles(node: PackageNode, testOnly: boolean): number {
	const count = testOnly ? node.testFiles.length : node.sourceFiles.length
	return count + node.children.reduce((sum, child) => sum + countTreeFiles(child, testOnly), 0)
}

// ---------------------------------------------------------------------------
// System prompt section formatters
// ---------------------------------------------------------------------------

function readWorkspaceMemberDependencies(
	cwd: string,
	member: WorkspaceMember,
): string[] {
	if (member.dependencyDisplay && member.dependencyDisplay.length > 0) {
		return member.dependencyDisplay.slice(0, 5)
	}
	let tables: Record<string, Record<string, string>> | undefined
	if (member.dependencies && Object.keys(member.dependencies).length > 0) {
		tables = {}
		for (const [d, meta] of Object.entries(member.dependencies)) {
			tables[d] = { path: meta.path ?? "", git: meta.git ?? "", tag: meta.tag ?? "", branch: meta.branch ?? "" }
		}
	} else {
		const memberToml = path.join(cwd, member.path, "cjpm.toml")
		if (!fs.existsSync(memberToml)) return []
		try {
			const content = fs.readFileSync(memberToml, "utf-8")
			const memberSections = splitTomlSections(content)
			const deps = memberSections.get("dependencies")
			if (!deps) return []
			tables = extractTomlInlineTables(deps)
		} catch {
			return []
		}
	}
	if (!tables) return []
	return Object.keys(tables)
		.map((d) => {
			const t = tables![d]
			if (t["path"]) return `${d}(path:${t["path"]})`
			if (t["git"]) return `${d}(git)`
			if (t["tag"]) return `${d}(tag:${t["tag"]})`
			if (t["branch"]) return `${d}(branch:${t["branch"]})`
			return d
		})
		.slice(0, 5)
}

function buildCompactProjectOverviewSection(
	cwd: string,
	info: CjpmProjectInfo,
	activePkg: string | null,
	activeFilePath: string | null,
): string {
	const lines: string[] = ["## 当前项目概览（紧凑）\n"]

	if (!info.isWorkspace) {
		const rootPkgName = info.name || undefined
		const pkgTree = getCachedPackageHierarchy(cwd, info.srcDir, rootPkgName)
		const srcCount = pkgTree ? countTreeFiles(pkgTree, false) : 0
		const testCount = pkgTree ? countTreeFiles(pkgTree, true) : 0
		lines.push(`项目: ${info.name} (${info.outputType}) v${info.version}`)
		lines.push(`目录: ${info.srcDir}/, 源文件: ${srcCount}, 测试文件: ${testCount}`)
		if (activePkg) lines.push(`当前编辑包: ${activePkg}`)
		if (pkgTree) {
			const pkgSummary = [pkgTree.packageName, ...pkgTree.children.map((c) => c.packageName)].slice(0, 6).join(", ")
			lines.push(`包概览: ${pkgSummary}${pkgTree.children.length > 5 ? " ..." : ""}`)
		}
		lines.push(`包声明规则: package 与 ${info.srcDir}/ 目录层级一致`)
		return lines.join("\n")
	}

	const members = info.members ?? []
	const resolvedMembers = members.slice(0, MAX_WORKSPACE_MEMBERS)
	lines.push(`项目: workspace (${resolvedMembers.length} 个模块)`)

	let activeMemberName: string | null = null
	if (activeFilePath) {
		const normalizedActivePath = activeFilePath.replace(/\\/g, "/")
		for (const m of resolvedMembers) {
			const memberRoot = path.join(cwd, m.path).replace(/\\/g, "/")
			if (normalizedActivePath.startsWith(memberRoot)) {
				activeMemberName = m.name
				break
			}
		}
	}

	for (const member of resolvedMembers) {
		const memberCwd = path.join(cwd, member.path)
		const pkgTree = getCachedPackageHierarchy(memberCwd, "src", member.name)
		const srcCount = pkgTree ? countTreeFiles(pkgTree, false) : 0
		const testCount = pkgTree ? countTreeFiles(pkgTree, true) : 0
		const deps = readWorkspaceMemberDependencies(cwd, member)
		const activeTag = member.name === activeMemberName ? " ← 当前编辑模块" : ""
		const depSuffix = deps.length > 0 ? `, 依赖: ${deps.join(", ")}` : ""
		lines.push(`- ${member.name} (${member.outputType}): ${srcCount} 源/${testCount} 测${activeTag}${depSuffix}`)
	}

	if (activePkg) lines.push(`当前编辑包: ${activePkg}`)
	lines.push("包声明规则: package 与 src/ 目录层级一致；模块依赖变更后运行 `cjpm check`")
	return lines.join("\n")
}

function normalizeForSimilarity(text: string): string {
	let s = text.replace(/\r\n/g, "\n").toLowerCase().replace(/^\[[^\]]*\]\s*/, "")
	s = s.replace(/[a-z]:[\\/][^:\s)]+/gi, "FILE")
	s = s.replace(/(?:\/[\w.-]+)+\.(?:cj|toml)/gi, "FILE")
	s = s.replace(/(?:[\w.-]+\\)+[\w.-]+\.(?:cj|toml)/gi, "FILE")
	s = s.replace(/:\d+:\d+/g, ":L:L")
	s = s.replace(/\bline\s+\d+\b/gi, "line L")
	s = s.replace(/(?<!\d):\d{1,6}(?!\d)/g, ":L")
	s = s.replace(/\s+/g, " ").trim()
	return s
}

function countLearnedFixLexiconOverlap(normalizedErrorPattern: string, normalizedMessage: string): number {
	const epTok = new Set(normalizedErrorPattern.split(" ").filter((t) => t.length > 1))
	const msgTok = new Set(normalizedMessage.split(" ").filter((t) => t.length > 1))
	let n = 0
	for (const t of epTok) {
		if (LEARNED_FIX_CATEGORY_LEXICON.has(t) && msgTok.has(t)) n++
	}
	return n
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0
	if (a.length === 0) return b.length
	if (b.length === 0) return a.length
	const row = new Array(b.length + 1)
	for (let j = 0; j <= b.length; j++) row[j] = j
	for (let i = 1; i <= a.length; i++) {
		let prev = i - 1
		row[0] = i
		for (let j = 1; j <= b.length; j++) {
			const tmp = row[j]
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost)
			prev = tmp
		}
	}
	return row[b.length]
}

function stringSimilarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length)
	if (maxLen === 0) return 1
	const lenDiff = Math.abs(a.length - b.length)
	if (lenDiff / maxLen > 0.4) return 0
	const dist = levenshteinDistance(a, b)
	return Math.max(0, 1 - dist / maxLen)
}

function primitiveTypeTokens(s: string): string[] {
	const m = s.match(/\b(Int\d+|UInt\d+|Float\d+|Bool|String)\b/gi)
	if (!m) return []
	return [...new Set(m.map((x) => x.toLowerCase()))]
}

function extractOrderedPrimitiveTypePair(s: string): [string, string] | null {
	const m = s.match(/\b(Int\d+|UInt\d+|Float\d+|Bool|String)\b/gi)
	if (!m || m.length < 2) return null
	return [m[0].toLowerCase(), m[1].toLowerCase()]
}

function primitiveTypeSetsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	const sb = new Set(b)
	return a.every((t) => sb.has(t))
}

function learnedPatternMatchesDiagnostics(p: LearnedFixPattern, diagnostics: vscode.Diagnostic[]): boolean {
	const ep = normalizeForSimilarity(p.errorPattern)
	if (!ep || diagnostics.length === 0) return false
	const epTypes = primitiveTypeTokens(p.errorPattern)
	const epPair = extractOrderedPrimitiveTypePair(p.errorPattern)
	const hasExplicitCode = Boolean(p.diagnosticCode?.trim())
	return diagnostics.some((d) => {
		const msg = normalizeForSimilarity(d.message).slice(0, 220)
		if (!msg) return false
		const code = normalizeDiagnosticCode(d)?.toLowerCase()
		const pCode = p.diagnosticCode?.trim().toLowerCase()
		if (pCode) {
			if (code && code !== pCode) return false
			if (code === pCode) return true
		}
		const tagged = p.errorPattern.match(/^\[([^\]]+)\]/)?.[1]?.toLowerCase()
		if (code && tagged && code !== tagged) return false
		if (code && (tagged === code || ep.includes(`[${code}]`) || msg.includes(`[${code}]`))) return true
		// Stricter substring match when pattern does not pin a diagnostic code
		if (!hasExplicitCode && !code) {
			if (ep.length >= 14 && (msg.includes(ep) || (ep.length <= 80 && ep.includes(msg)))) return true
		} else if (ep.length >= 14 && (msg.includes(ep) || ep.includes(msg))) {
			return true
		}
		const msgTypes = primitiveTypeTokens(d.message)
		const msgPair = extractOrderedPrimitiveTypePair(d.message)
		const typeCtx = /mismatch|不匹配|expected|需要|found|得到|类型|type/.test(ep + msg)
		if (epPair && msgPair && epPair[0] === msgPair[0] && epPair[1] === msgPair[1] && typeCtx) {
			return true
		}
		if (epTypes.length >= 2 && msgTypes.length >= 2 && primitiveTypeSetsEqual(epTypes, msgTypes) && typeCtx) {
			return true
		}
		const kw = countLearnedFixLexiconOverlap(ep, msg)
		const epHead = ep.slice(0, 14)
		const msgHead = msg.slice(0, 14)
		const roughSub =
			ep.length < 12 ||
			msg.includes(epHead) ||
			ep.includes(msgHead) ||
			kw > 0 ||
			[...LEARNED_FIX_CATEGORY_LEXICON].some((w) => w.length >= 2 && ep.includes(w) && msg.includes(w))
		if (!roughSub) return false
		let threshold = hasExplicitCode ? 0.75 : 0.82
		threshold -= Math.min(4, kw) * 0.05
		threshold = Math.max(hasExplicitCode ? 0.6 : 0.68, threshold)
		return stringSimilarity(ep, msg) >= threshold
	})
}

function learnedPatternSuccessRate(p: LearnedFixPattern): number {
	const s = p.successCount ?? 0
	const f = p.failCount ?? 0
	const t = s + f
	if (t === 0) return (p.occurrences ?? 0) > 0 ? 0.5 : 0
	return s / t
}

function learnedPatternTimeWeight(p: LearnedFixPattern): number {
	if (!p.lastSeenAt) return 1
	const t = Date.parse(p.lastSeenAt)
	if (Number.isNaN(t)) return 1
	const ageDays = (Date.now() - t) / (1000 * 60 * 60 * 24)
	if (ageDays > 90) return 0.5
	if (ageDays > 30) return 0.75
	return 1
}

/**
 * Built-in seed fixes to address cold-start when no project-specific learned-fixes.json exists.
 * These cover the most frequently encountered Cangjie compilation errors.
 */
const BUILTIN_SEED_FIXES: LearnedFixPattern[] = [
	{
		errorPattern: "undeclared identifier|未找到符号",
		fix: "检查是否缺少 import 语句。常见遗漏: import std.collection.* (ArrayList/HashMap), import std.console.* (println), import std.io.* (文件IO)。检查拼写和包可见性(public)。",
		successCount: 5, failCount: 0,
	},
	{
		errorPattern: "type mismatch|类型不匹配",
		fix: "检查赋值/传参的类型是否一致。常见: String vs Int64 需显式转换 Int64.parse(str); ?T 需用 ?? 解包; Array<T> 与 ArrayList<T> 不直接兼容需构造。",
		successCount: 4, failCount: 0,
	},
	{
		errorPattern: "cannot call mut func on.*let|let.*调用.*mut",
		fix: "将 let 绑定改为 var 绑定。mut 方法只能在 var 绑定的 struct 实例上调用。示例: var counter = Counter() 然后 counter.inc()。",
		successCount: 5, failCount: 0,
	},
	{
		errorPattern: "recursive struct|struct.*自引用|infinite.*size",
		fix: "struct 是值类型不能自引用。改用 class（引用类型）或将自引用字段声明为 ?StructName（Option 包装）。",
		successCount: 3, failCount: 0,
	},
	{
		errorPattern: "non-exhaustive|match.*不穷尽|missing.*case",
		fix: "match 表达式必须覆盖所有可能分支。添加遗漏的 case 或使用 case _ => 作为兜底。对 enum 类型需要列出所有变体。",
		successCount: 4, failCount: 0,
	},
	{
		errorPattern: "main.*返回.*void|main.*return type",
		fix: "main 函数返回类型必须为 Int64，不能省略或使用其他类型。正确签名: main(): Int64 { ... return 0 }",
		successCount: 3, failCount: 0,
	},
	{
		errorPattern: "package.*不一致|package.*mismatch|package.*directory",
		fix: "package 声明必须与 src/ 下的目录结构严格对应。例如 src/foo/bar/baz.cj 中应为 package foo.bar。",
		successCount: 3, failCount: 0,
	},
	{
		errorPattern: "cannot find.*import|import.*not found",
		fix: "检查 import 路径是否正确。std 标准库用 import std.模块名.* 格式。项目内部包用 import 包名.* 且需在 cjpm.toml 中配置依赖。",
		successCount: 3, failCount: 0,
	},
	{
		errorPattern: "override.*not open|redef.*override",
		fix: "override 只能用于 open 修饰的父类方法；非 open 方法需用 redef 而非 override。检查父类方法声明是否有 open 修饰符。",
		successCount: 2, failCount: 0,
	},
	{
		errorPattern: "interface.*not implement|未实现.*接口",
		fix: "实现 interface 需要覆盖所有方法。用 class MyClass <: InterfaceName { public func methodName(...): ReturnType { ... } } 语法。",
		successCount: 2, failCount: 0,
	},
	{
		errorPattern: "HashMap.*Hashable|HashSet.*Hashable",
		fix: "HashMap 的 Key 类型须实现 Hashable & Equatable<K>。自定义类型用作 Key 需要 extend 实现这两个接口或使用已内置实现的类型(String, Int64 等)。",
		successCount: 3, failCount: 0,
	},
	{
		errorPattern: "spawn.*capture.*var|并发.*捕获.*可变",
		fix: "spawn 块内不能直接捕获外部 var 变量。使用 Mutex<T> 包装共享状态，或将值在 spawn 前拷贝到 let 绑定。",
		successCount: 2, failCount: 0,
	},
]

/**
 * Load project-specific error→fix hints from .njust_ai/learned-fixes.json (manual curation).
 * Falls back to BUILTIN_SEED_FIXES when no project file exists.
 * Prioritizes patterns matching current diagnostics and sorts by empirical success rate.
 */
function loadLearnedFixesSection(cwd: string, diagnostics: vscode.Diagnostic[]): string | null {
	const rawData = loadLearnedFixes(cwd)
	const parsed: LearnedFixPattern[] = []
	for (const entry of rawData.patterns) {
		if (!entry || typeof entry !== "object") continue
		const p = entry as LearnedFixPattern
		if (typeof p.errorPattern !== "string" || typeof p.fix !== "string") continue
		parsed.push(p)
	}

	const useSeedFixes = parsed.length === 0
	const effective = useSeedFixes ? BUILTIN_SEED_FIXES : parsed
	if (effective.length === 0) return null

	try {
		const displayable = effective.filter((p) => {
			const s = p.successCount ?? 0
			const f = p.failCount ?? 0
			if (f >= 3 && f > s) return false
			const rate = learnedPatternSuccessRate(p)
			return rate >= 0.4 || s + f < 3
		})
		if (displayable.length === 0) return null

		const matched =
			diagnostics.length > 0 ? displayable.filter((p) => learnedPatternMatchesDiagnostics(p, diagnostics)) : []
		const matchedSet = new Set(matched)
		const unmatched = displayable.filter((p) => !matchedSet.has(p))
		const rateSort = (a: LearnedFixPattern, b: LearnedFixPattern) =>
			learnedPatternSuccessRate(b) * learnedPatternTimeWeight(b) -
				learnedPatternSuccessRate(a) * learnedPatternTimeWeight(a) ||
			(b.failCount ?? 0) - (a.failCount ?? 0)
		matched.sort(rateSort)
		unmatched.sort(rateSort)
		const ordered = [...matched, ...unmatched]

		const sourceLabel = useSeedFixes
			? "内置常见修复提示"
			: `本项目常见修复提示（${NJUST_AI_CONFIG_DIR}/${LEARNED_FIXES_FILE}）`
		const header = `## ${sourceLabel}\n\n`
		const lines: string[] = []
		let used = header.length

		for (const p of ordered) {
			const epDisplay = p.errorPattern.replace(/`/g, "'").slice(0, 200)
			const fixDisplay = p.fix ? p.fix.replace(/`/g, "'").slice(0, 500) : "（尚未学到修复方式）"
			const s = p.successCount ?? 0
			const f = p.failCount ?? 0
			const occ =
				typeof p.occurrences === "number" && p.occurrences > 0 ? `（约 ${p.occurrences} 次）` : ""
			const stats =
				s + f > 0 ? ` [验证 ${s} 成功 / ${f} 失败${f > s ? " · 低置信" : ""}]` : ""
			const relevant = diagnostics.length > 0 && matchedSet.has(p) ? "「当前诊断相关」" : ""
			const line = `- ${relevant}匹配 \`${epDisplay}\`：${fixDisplay}${stats}${occ}`
			if (used + line.length + 1 > LEARNED_FIXES_MAX_SECTION_CHARS) {
				lines.push(
					`\n…（其余条目已省略以保持上下文长度；可打开 ${NJUST_AI_CONFIG_DIR}/${LEARNED_FIXES_FILE} 查看全部）`,
				)
				break
			}
			lines.push(line)
			used += line.length + 1
		}

		if (lines.length === 0) return null
		return `${header}${lines.join("\n")}`
	} catch {
		return null
	}
}

/**
 * Auto-record a resolved error→fix pattern to the learned-fixes JSON.
 * Called by the compile-fix loop when an error is successfully resolved.
 * Deduplicates by errorPattern (bumps occurrences), caps at LEARNED_FIXES_MAX_PATTERNS.
 */
export function recordLearnedFix(
	cwd: string,
	errorPattern: string,
	fix: string,
	projectSpecific = true,
): void {
	const data = loadLearnedFixes(cwd)

	// Normalize for dedup
	const normalizedPattern = errorPattern.trim().toLowerCase().slice(0, 300)

	// Check for existing match (dedup by error pattern similarity)
	const existing = data.patterns.find((p) => {
		const existingNorm = p.errorPattern.trim().toLowerCase().slice(0, 300)
		return existingNorm === normalizedPattern || existingNorm.includes(normalizedPattern) || normalizedPattern.includes(existingNorm)
	})

	if (existing) {
		existing.occurrences = (existing.occurrences || 1) + 1
		existing.successCount = (existing.successCount || 0) + 1
		existing.lastSeenAt = new Date().toISOString()
		if (fix.length > existing.fix.length) {
			existing.fix = fix.slice(0, 1000)
		}
	} else {
		if (data.patterns.length >= LEARNED_FIXES_MAX_PATTERNS) {
			// Evict least-seen entry
			data.patterns.sort((a, b) => (a.occurrences || 0) - (b.occurrences || 0))
			data.patterns.shift()
		}
		data.patterns.push({
			errorPattern: errorPattern.slice(0, 500),
			fix: fix.slice(0, 1000),
			projectSpecific,
			occurrences: 1,
			successCount: 1,
			failCount: 0,
			lastSeenAt: new Date().toISOString(),
		})
	}

	try {
		saveLearnedFixes(cwd, data)
	} catch {
		// Non-critical: ignore write failures
	}
}

/**
 * Increment failCount for a learned pattern matching this error snippet.
 * If no existing entry matches, creates a shell entry (empty fix, failCount=1)
 * so that recurring failures are tracked even before a fix is discovered.
 */
export function recordLearnedFailure(cwd: string, errorSnippet: string): void {
	const data = loadLearnedFixes(cwd)

	const normalizedPattern = errorSnippet.trim().toLowerCase().slice(0, 300)
	if (!normalizedPattern) return

	const existing = data.patterns.find((p) => {
		const existingNorm = p.errorPattern.trim().toLowerCase().slice(0, 300)
		return existingNorm === normalizedPattern || existingNorm.includes(normalizedPattern) || normalizedPattern.includes(existingNorm)
	})

	if (existing) {
		existing.failCount = (existing.failCount || 0) + 1
		existing.lastSeenAt = new Date().toISOString()
	} else {
		if (data.patterns.length >= LEARNED_FIXES_MAX_PATTERNS) {
			data.patterns.sort((a, b) => (a.occurrences || 0) - (b.occurrences || 0))
			data.patterns.shift()
		}
		data.patterns.push({
			errorPattern: errorSnippet.slice(0, 500),
			fix: "",
			projectSpecific: true,
			occurrences: 1,
			successCount: 0,
			failCount: 1,
			lastSeenAt: new Date().toISOString(),
		})
	}

	try {
		saveLearnedFixes(cwd, data)
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// cjpm tree integration (Phase 2.3) — precise dependency tree
// ---------------------------------------------------------------------------

/**
 * Run `cjpm tree` via CangjieCompileGuard and return formatted context section.
 * Uses lazy require to avoid circular dependency.
 * Returns null if cjpm is unavailable or no tree output.
 */
const CJPM_TREE_CACHE_TTL_MS = 60_000
let cachedCjpmTree: {
	result: string | null
	cwd: string
	tomlMtime: number
	lockMtime: number
	fetchedAt: number
} | null = null

async function getCjpmTreeSection(cwd: string): Promise<string | null> {
	try {
		const tomlPath = path.join(cwd, "cjpm.toml")
		if (!fs.existsSync(tomlPath)) return null
		const tomlMtime = fs.statSync(tomlPath).mtimeMs
		const lockPath = path.join(cwd, "cjpm.lock")
		const lockMtime = fs.existsSync(lockPath) ? fs.statSync(lockPath).mtimeMs : 0
		const now = Date.now()
		if (
			cachedCjpmTree &&
			cachedCjpmTree.cwd === cwd &&
			cachedCjpmTree.tomlMtime === tomlMtime &&
			cachedCjpmTree.lockMtime === lockMtime &&
			now - cachedCjpmTree.fetchedAt < CJPM_TREE_CACHE_TTL_MS
		) {
			return cachedCjpmTree.result
		}

		const summary = await getCjpmTreeSummaryForPrompt(cwd)
		const result = summary || null
		cachedCjpmTree = { result, cwd, tomlMtime, lockMtime, fetchedAt: now }
		return result
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Dynamic coding rules injection (context-aware)
// ---------------------------------------------------------------------------

const CODING_RULES_MAX_CHARS = 3000

/**
 * Selectively inject coding rules based on the current editing context.
 * Instead of blindly inlining the full CANGJIE_CODING_RULES (~870 lines)
 * into every prompt, we inject only the relevant sections based on:
 *   - What files are currently open (test file → test templates)
 *   - What imports are present (std.sync → concurrency rules)
 *   - Whether there are compilation errors (→ error table)
 *   - Whether it's a workspace project (→ workspace workflow)
 */
/** Last segment + parent module for better corpus recall, e.g. std.collection.HashMap → "collection HashMap". */
function importPathToCorpusQuery(imp: string): string | null {
	const parts = imp.split(".").filter((p) => p && p !== "*")
	if (parts.length === 0) return null
	if (parts.length === 1) return parts[0]
	return `${parts[parts.length - 2]} ${parts[parts.length - 1]}`
}

/** Short query from diagnostic: prefer CJC pattern category + trimmed message; else keyword heuristic. */
function diagnosticToCorpusQuery(d: vscode.Diagnostic): string | null {
	const raw = d.message.replace(/[`'"]/g, " ").replace(/\s+/g, " ").trim()
	if (!raw) return null
	const resolved = resolveCjcPatternForDiagnostic(d)
	if (resolved) {
		const head = raw.split(/[:：，,。]/)[0]?.trim() ?? raw
		return `${resolved.category} ${head}`.slice(0, 120)
	}
	const cleaned = raw.replace(/^(error|warning)\s*[:\d\[\]]*\s*/i, "")
	const words = cleaned
		.split(/\s+/)
		.filter((w) => w.length > 2 && !/^\d+$/.test(w) && !/^[|:=]+$/.test(w))
	const fromWords = words.slice(0, 5).join(" ")
	return (fromWords || cleaned).slice(0, 90) || null
}

/**
 * Derive corpus search queries from current imports and diagnostics.
 * Merges std imports and diagnostics into fewer BM25 queries (typically 1–3) to cut scan cost.
 */
/** At most 5 BM25 queries: merged imports, merged diagnostics (reduces index scans). */
const AUTO_CORPUS_QUERY_MAX = 5
const AUTO_CORPUS_QUERY_MAX_LEN = 280

/** Group `std.a.b...` by top module family `std.a` for separate BM25 queries. */
function stdImportFamily(imp: string): string {
	const parts = imp.split(".").filter(Boolean)
	if (parts.length < 2 || parts[0] !== "std") return imp
	return `${parts[0]}.${parts[1]}`
}

function buildAutoCorpusQueries(imports: string[], diagnostics: vscode.Diagnostic[]): string[] {
	const stdImports: string[] = []
	const localImports: string[] = []
	for (const i of imports) {
		if (i.startsWith("std.")) stdImports.push(i)
		else localImports.push(i)
	}
	const byFamily = new Map<string, string[]>()
	for (const i of stdImports) {
		const fam = stdImportFamily(i)
		const g = byFamily.get(fam) ?? []
		g.push(i)
		byFamily.set(fam, g)
	}
	const stdQueries: string[] = []
	for (const [, group] of byFamily) {
		const q = group
			.map((i) => importPathToCorpusQuery(i))
			.filter((x): x is string => Boolean(x))
			.join(" ")
			.trim()
		if (q) stdQueries.push(q.slice(0, AUTO_CORPUS_QUERY_MAX_LEN))
	}
	stdQueries.sort((a, b) => b.length - a.length)

	const localPart = localImports
		.slice(0, 8)
		.map((i) => importPathToCorpusQuery(i))
		.filter((q): q is string => Boolean(q))
		.join(" ")
		.trim()

	const diagQuery = diagnostics
		.map((d) => diagnosticToCorpusQuery(d))
		.filter((q): q is string => Boolean(q))
		.join(" ")
		.trim()

	const out: string[] = []
	for (const q of stdQueries.slice(0, 3)) {
		if (out.length >= AUTO_CORPUS_QUERY_MAX) break
		out.push(q)
	}
	if (localPart && out.length < AUTO_CORPUS_QUERY_MAX) {
		out.push(localPart.slice(0, AUTO_CORPUS_QUERY_MAX_LEN))
	}
	if (diagQuery && out.length < AUTO_CORPUS_QUERY_MAX) {
		out.push(diagQuery.slice(0, AUTO_CORPUS_QUERY_MAX_LEN))
	}
	return out.slice(0, AUTO_CORPUS_QUERY_MAX)
}

/** Pre-baked one-line API hints for std roots — avoids extra corpus hits for common imports. */
const STDLIB_API_SIGNATURE_HINTS: Record<string, string> = {
	"std.collection":
		"ArrayList<T>, HashMap<K,V>, HashSet<T>, TreeMap<K,V>; HashMap 常要求 K <: Hashable & Equatable<K>，TreeMap 常要求 K <: Comparable<K>",
	"std.io": "InputStream, OutputStream, 读写与缓冲",
	"std.fs": "路径与文件系统遍历",
	"std.net": "TCP/UDP、HTTP、Socket",
	"std.sync": "Mutex, ReentrantMutex, Atomic*, synchronized",
	"std.time": "日期时间与 Duration",
	"std.math": "常用数学函数与常量",
	"std.regex": "Regex 构造与匹配",
	"std.console": "println, readLine",
	"std.convert": "ToString 与各类型解析",
	"std.unittest": "@Test, @TestCase, @Assert",
	"std.objectpool": "对象池借还与复用策略",
	"std.unicode": "Unicode 字符分类、规范化与编码处理",
	"std.log": "日志记录器、级别与格式化输出",
	"std.ffi": "foreign/@C 声明、跨语言类型映射",
	"std.format": "字符串与数值格式化输出",
	"std.random": "随机数与采样",
	"std.process": "子进程与参数",
	"std.env": "环境变量读写",
	"std.reflect": "反射与 Annotation",
	"std.sort": "排序算法",
	"std.binary": "字节与Endian",
	"std.ast": "宏与 AST 构造",
	"std.crypto": "摘要与对称算法入口",
	"std.database": "SQL 访问抽象",
	"std.core": "自动导入核心类型",
	"std.deriving": "派生宏（如 Equatable）",
	"std.overflow": "防溢出算术",
}

/**
 * Parameter-level API signatures for the top-20 highest-misuse stdlib APIs.
 * These are injected when the corresponding import is detected.
 * Modules covered here are also exempt from search gate warnings.
 */
export const STDLIB_CRITICAL_SIGNATURES: Record<string, string> = {
	"std.collection": [
		"class ArrayList<T> { init(); init(capacity: Int64); func append(T): Unit; func get(Int64): T; func set(Int64, T): Unit; prop size: Int64; func remove(Int64): T; func iterator(): Iterator<T> }",
		"class HashMap<K, V> where K <: Hashable & Equatable<K> { init(); func put(K, V): Unit; func get(K): ?V; func contains(K): Bool; func remove(K): ?V; prop size: Int64 }",
		"class HashSet<T> where T <: Hashable & Equatable<T> { init(); func put(T): Bool; func contains(T): Bool; func remove(T): Bool; prop size: Int64 }",
		"class TreeMap<K, V> where K <: Comparable<K> { init(); func put(K, V): Unit; func get(K): ?V; prop size: Int64 }",
	].join("\n"),
	"std.io": [
		"class InputStream { func read(Array<Byte>): Int64; func close(): Unit }",
		"class OutputStream { func write(Array<Byte>): Unit; func flush(): Unit; func close(): Unit }",
		"class BufferedReader { init(InputStream); func readLine(): ?String; func close(): Unit }",
		"class StringReader <: InputStream { init(String) }",
		"class StringWriter <: OutputStream { init(); func toString(): String }",
	].join("\n"),
	"std.fs": [
		"class File { static func readString(String): String; static func writeString(String, String): Unit; static func exists(String): Bool; static func delete(String): Unit }",
		"class Path { init(String); func resolve(String): Path; func parent(): ?Path; prop fileName: String; func toString(): String }",
		"class Directory { static func create(String): Unit; static func listEntries(String): Array<String> }",
	].join("\n"),
	"std.sync": [
		"class Mutex<T> { init(T); func lock(): MutexGuard<T>; func tryLock(): ?MutexGuard<T> }",
		"class ReentrantMutex { init(); func lock(): Unit; func unlock(): Unit; func tryLock(): Bool }",
		"class AtomicInt64 { init(Int64); func load(): Int64; func store(Int64): Unit; func fetchAdd(Int64): Int64 }",
		"class AtomicBool { init(Bool); func load(): Bool; func store(Bool): Unit }",
		"func synchronized<T>(lock: ReentrantMutex, body: () -> T): T",
	].join("\n"),
	"std.regex": [
		"class Regex { init(String); func matches(String): Bool; func find(String): ?MatchResult; func findAll(String): Array<MatchResult>; func replace(String, String): String }",
		"class MatchResult { prop value: String; prop start: Int64; prop end: Int64; func group(Int64): ?String }",
	].join("\n"),
	"std.console": "func println(String): Unit\nfunc print(String): Unit\nfunc readLine(): String",
	"std.convert": [
		"interface ToString { func toString(): String }",
		"func Int64.parse(String): ?Int64",
		"func Float64.parse(String): ?Float64",
		"func Bool.parse(String): ?Bool",
	].join("\n"),
	"std.unittest": [
		"@Test — 标记测试类",
		"@TestCase — 标记测试方法",
		"@Assert(condition) — 断言宏",
		"@Expect(condition) — 非致命断言",
		"@Timeout(ms: Int64) — 超时限制",
	].join("\n"),
	"std.format": [
		"func format(fmt: String, args: Array<ToString>): String",
		"字符串插值: \"value = ${expr}\" — expr 须实现 ToString",
	].join("\n"),
	"std.random": [
		"class Random { init(); init(seed: Int64); func nextInt64(): Int64; func nextInt64(bound: Int64): Int64; func nextFloat64(): Float64; func nextBool(): Bool }",
	].join("\n"),
	"std.math": [
		"func abs(Int64): Int64; func abs(Float64): Float64",
		"func min<T>(T, T): T where T <: Comparable<T>; func max<T>(T, T): T where T <: Comparable<T>",
		"func sqrt(Float64): Float64; func pow(Float64, Float64): Float64",
		"const PI: Float64; const E: Float64",
	].join("\n"),
	"std.time": [
		"class DateTime { static func now(): DateTime; func toString(): String; func toTimestamp(): Int64 }",
		"class Duration { static func fromSeconds(Int64): Duration; static func fromMillis(Int64): Duration; prop totalMillis: Int64 }",
	].join("\n"),
	"std.process": [
		"class Process { static func run(command: String, args: Array<String>): ProcessResult }",
		"class ProcessResult { prop exitCode: Int64; prop stdout: String; prop stderr: String }",
	].join("\n"),
	"std.env": [
		"func getEnv(String): ?String",
		"func setEnv(String, String): Unit",
		"func currentDir(): String",
	].join("\n"),
	"std.log": [
		"class Logger { static func getLogger(name: String): Logger; func info(String): Unit; func warn(String): Unit; func error(String): Unit; func debug(String): Unit }",
		"enum LogLevel { case DEBUG | INFO | WARN | ERROR }",
	].join("\n"),
}

function buildStdlibSignatureHintsSection(
	imports: string[],
	docsBase: string | null | undefined,
	globalStoragePath?: string,
): string | null {
	let hints: Record<string, string> = STDLIB_API_SIGNATURE_HINTS
	if (docsBase && fs.existsSync(docsBase) && globalStoragePath) {
		hints = mergeStdlibConstraintHintsFromCorpus({ ...STDLIB_API_SIGNATURE_HINTS }, docsBase, globalStoragePath)
	}
	const keys = Object.keys(hints).sort((a, b) => b.length - a.length)
	const lines: string[] = []
	const matchedKeys = new Set<string>()
	for (const imp of imports) {
		if (!imp.startsWith("std.")) continue
		for (const key of keys) {
			if (imp.startsWith(key) && !matchedKeys.has(key)) {
				matchedKeys.add(key)
				lines.push(`- \`${key}\`: ${hints[key]}`)
				break
			}
		}
	}
	if (lines.length === 0) return null

	// Append detailed critical signatures for matched imports
	const criticalLines: string[] = []
	for (const key of matchedKeys) {
		const sig = STDLIB_CRITICAL_SIGNATURES[key]
		if (sig) {
			criticalLines.push(`### ${key} 关键签名\n\`\`\`\n${sig}\n\`\`\``)
		}
	}
	const criticalBlock = criticalLines.length > 0
		? `\n\n## 标准库关键 API 签名（参数级精度）\n\n${criticalLines.join("\n\n")}`
		: ""

	return `## 标准库 API 摘要（预置速查）\n\n${lines.join("\n")}\n\n详细签名仍以语料库 libs/ 与 manual/ 为准。${criticalBlock}`
}

/** Bundled corpus `extra/*.md` — keyword → file for intent-based few-shot (see CangjieCorpus-1.0.0/extra/). */
const CORPUS_EXTRA_SNIPPETS: { rel: string; keys: string[] }[] = [
	{ rel: "extra/HashMap.md", keys: ["hashmap"] },
	{ rel: "extra/HashSet.md", keys: ["hashset"] },
	{ rel: "extra/Collection.md", keys: ["arraylist", "collection"] },
	{ rel: "extra/Option.md", keys: ["option", "optional", "none", "some"] },
	{ rel: "extra/Sorting.md", keys: ["sorting", " sort", "排序"] },
	{ rel: "extra/String.md", keys: ["string", "substring", "runestring"] },
	{ rel: "extra/Array.md", keys: ["varray", "array"] },
	{ rel: "extra/Numbers.md", keys: ["int64", "uint", "integer", "浮点"] },
	{ rel: "extra/Tuple.md", keys: ["tuple"] },
	{ rel: "extra/Function.md", keys: ["closure", "lambda"] },
	{ rel: "extra/Rune.md", keys: ["rune", "unicode"] },
	{ rel: "extra/Operator.md", keys: ["operator", "operator func", "运算符重载"] },
	{ rel: "extra/Generic.md", keys: ["generic", "constraint", "where", "泛型约束"] },
	{ rel: "extra/Concurrency.md", keys: ["concurrent", "spawn", "mutex", "并发"] },
]

const CORPUS_EXTRA_MAX_FILES = 2
const CORPUS_EXTRA_MAX_CHARS_PER_FILE = 1600

let corpusExtraLatinKeyRegex: Map<string, RegExp> | null = null

function getCorpusExtraLatinKeyRegexMap(): Map<string, RegExp> {
	if (corpusExtraLatinKeyRegex) return corpusExtraLatinKeyRegex
	const m = new Map<string, RegExp>()
	for (const { keys } of CORPUS_EXTRA_SNIPPETS) {
		for (const key of keys) {
			const k = key.toLowerCase()
			if (!k || /[\u4e00-\u9fff]/.test(k)) continue
			if (m.has(k)) continue
			try {
				const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				m.set(k, new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, "i"))
			} catch {
				/* skip malformed key */
			}
		}
	}
	corpusExtraLatinKeyRegex = m
	return m
}

function corpusExtraHaystackMatchesKey(hay: string, key: string, latinMap: Map<string, RegExp>): boolean {
	const k = key.toLowerCase()
	if (!k) return false
	if (/[\u4e00-\u9fff]/.test(k)) return hay.includes(k)
	const re = latinMap.get(k)
	return re ? re.test(hay) : hay.includes(k)
}

function buildCorpusExtraFewShotSection(
	corpusRoot: string,
	imports: string[],
	diagnostics: vscode.Diagnostic[],
): string | null {
	if (!fs.existsSync(corpusRoot)) return null

	const textChunks: string[] = []
	for (const ed of vscode.window.visibleTextEditors) {
		if (ed.document.languageId === "cangjie" || ed.document.fileName.endsWith(".cj")) {
			textChunks.push(ed.document.getText().slice(0, 2800))
		}
	}
	const hay = (
		imports.join(" ") +
		" " +
		diagnostics.map((d) => d.message).join(" ") +
		" " +
		textChunks.join(" ")
	).toLowerCase()

	const latinMap = getCorpusExtraLatinKeyRegexMap()
	const picked: string[] = []
	const usedRel = new Set<string>()
	for (const { rel, keys } of CORPUS_EXTRA_SNIPPETS) {
		if (picked.length >= CORPUS_EXTRA_MAX_FILES) break
		if (usedRel.has(rel)) continue
		if (!keys.some((k) => corpusExtraHaystackMatchesKey(hay, k, latinMap))) continue
		const fp = path.join(corpusRoot, rel)
		if (!fs.existsSync(fp)) continue
		try {
			const raw = readFileUtf8Lru(fp)
			if (!raw) continue
			let body = raw.trim().replace(/\r\n/g, "\n")
			if (body.length > CORPUS_EXTRA_MAX_CHARS_PER_FILE) {
				body = body.slice(0, CORPUS_EXTRA_MAX_CHARS_PER_FILE) + "\n…"
			}
			usedRel.add(rel)
			const title = path.basename(rel, ".md")
			picked.push(`### 语料示例: ${title}\n来源: \`${rel}\`\n\n${body}`)
		} catch {
			/* skip */
		}
	}

	if (picked.length === 0) return null
	return (
		`## 语料库 extra/ 参考片段（意图匹配）\n\n` +
		`编写特性前可对齐以下官方示例风格；完整内容请用 read_file 打开对应路径。\n\n` +
		picked.join("\n\n---\n\n")
	)
}

function buildContextualCodingRules(
	imports: string[],
	projectInfo: CjpmProjectInfo | null,
	diagnostics: vscode.Diagnostic[],
	hasSpecificDiagnosticGuidance = false,
): string | null {
	const parts: string[] = []
	let budget = CODING_RULES_MAX_CHARS

	const hasActiveCangjieFile = vscode.window.visibleTextEditors.some(
		(e) => e.document.languageId === "cangjie" || e.document.fileName.endsWith(".cj"),
	)

	if (!hasActiveCangjieFile && !projectInfo) return null

	const hasTestFile = vscode.window.visibleTextEditors.some(
		(e) => e.document.fileName.endsWith("_test.cj"),
	)
	const hasSyncImport = imports.some((i) => i.startsWith("std.sync"))
	const diags = diagnostics
	const hasErrors = diags.some(
		(d) => d.severity === vscode.DiagnosticSeverity.Error,
	)
	const isWorkspace = projectInfo?.isWorkspace ?? false

	// Always inject the core project templates (compact)
	const coreTemplates =
		"## 仓颉代码模板\n\n" +
		"### 可执行项目入口\n```cangjie\npackage my_app\nimport std.console.*\nmain(): Int64 {\n    println(\"Hello, Cangjie!\")\n    return 0\n}\n```\n"

	if (budget >= coreTemplates.length) {
		parts.push(coreTemplates)
		budget -= coreTemplates.length
	}

	// Test templates when editing test files
	if (hasTestFile) {
		const testTemplate =
			"### 测试文件模板\n```cangjie\npackage my_app\nimport std.unittest.*\nimport std.unittest.testmacro.*\n@Test\nclass MyTest {\n    @TestCase\n    func testBasic() {\n        @Assert(1 + 1 == 2)\n    }\n}\n```\n"
		if (budget >= testTemplate.length) {
			parts.push(testTemplate)
			budget -= testTemplate.length
		}
	}

	// Error handling patterns when there are active errors.
	// If diagnostics/doc mappings are already injected in detail, keep this table compact.
	if (hasErrors && !hasSpecificDiagnosticGuidance) {
		const errorTable =
			"### 常见编译错误速查\n" +
			"| 错误类型 | 解决方案 |\n" +
			"|----------|----------|\n" +
			"| 未找到符号 | 检查 import 语句和 cjpm.toml 依赖 |\n" +
			"| 类型不匹配 | 检查类型声明和转换 |\n" +
			"| let 变量赋值 | 改用 `var` 声明 |\n" +
			"| mut 函数限制 | let 变量调用 mut 函数 → 改用 `var` |\n" +
			"| 递归结构体 | struct 不能自引用 → 改用 class 或 Option |\n" +
			"| match 不穷尽 | 补全 case 或添加 `case _ =>` |\n" +
			"| 参数数量错误 | 检查命名参数需用 `name:` 语法 |\n" +
			"| redef/override 混淆 | 检查父方法是否 open；open 用 override，非 open 用 redef |\n" +
			"| sealed 类限制 | 仅在定义模块内继承 sealed class |\n" +
			"| init 顺序错误 | 子类 init 首行调用 super() |\n"
		if (budget >= errorTable.length) {
			parts.push(errorTable)
			budget -= errorTable.length
		}
	}

	// Diagnostic-driven targeted code templates based on actual error categories
	if (hasErrors && diags.length > 0) {
		const errorMessages = diags
			.filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
			.map((d) => (typeof d.message === "string" ? d.message : ""))
			.filter(Boolean)
		const categoriesPresent = new Set<string>()
		for (const msg of errorMessages) {
			const pattern = matchCjcErrorPattern(msg)
			if (pattern) categoriesPresent.add(pattern.category)
		}

		const diagnosticTemplates: Array<{ categories: string[]; template: string }> = [
			{
				categories: ["类型不匹配", "类型转换失败"],
				template:
					"### 类型转换速查\n" +
					"- `Int64 → String`: `\"${value}\"` 或 `value.toString()`\n" +
					"- `String → Int64`: `Int64.parse(str)` 返回 `?Int64`\n" +
					"- `Float64 → Int64`: `Int64(floatVal)` (截断)\n" +
					"- `Array<T> → ArrayList<T>`: `ArrayList<T>(arr)`\n" +
					"- `?T → T`: `opt ?? defaultVal` 或 `match(opt) { case Some(v) => v; case None => ... }`\n",
			},
			{
				categories: ["未找到符号", "缺少 import"],
				template:
					"### 常用 import 路径速查\n" +
					"- 集合: `import std.collection.*`\n" +
					"- IO: `import std.io.*` + `import std.fs.*`\n" +
					"- 控制台: `import std.console.*`\n" +
					"- 测试: `import std.unittest.*` + `import std.unittest.testmacro.*`\n" +
					"- 并发: `import std.sync.*`\n" +
					"- 网络: `import std.net.*`\n" +
					"- 正则: `import std.regex.*`\n" +
					"- 格式化: `import std.format.*`\n",
			},
			{
				categories: ["mut 函数限制", "不可变变量赋值"],
				template:
					"### let / var / mut 对照\n" +
					"- `let x = value` — 不可变绑定，不能重新赋值，不能调用 mut 方法\n" +
					"- `var x = value` — 可变绑定，可重新赋值，可调用 mut 方法\n" +
					"- `mut func foo()` — 修改 struct 自身字段的方法，调用者必须是 var 绑定\n" +
					"- **修复**: 将 `let obj = Struct()` 改为 `var obj = Struct()` 后再调用 `obj.mutMethod()`\n",
			},
			{
				categories: ["接口未实现", "接口未实现（精确）"],
				template:
					"### interface 实现模板\n" +
					"```cangjie\ninterface Printable {\n    func display(): String\n}\n" +
					"class MyClass <: Printable {\n    public func display(): String {\n        return \"MyClass\"\n    }\n}\n```\n",
			},
		]

		for (const dt of diagnosticTemplates) {
			if (dt.categories.some((c) => categoriesPresent.has(c))) {
				if (budget >= dt.template.length) {
					parts.push(dt.template)
					budget -= dt.template.length
				}
			}
		}
	}

	// Anti-patterns for let/var/mut when editing struct code
	if (hasActiveCangjieFile) {
		const antiPatterns =
			"### 常见反例\n" +
			"- ❌ `let c = Counter(); c.inc()` — let 绑定的 struct 不能调用 mut 方法 → ✅ `var c = Counter()`\n" +
			"- ❌ `struct Node { let next: Node }` — struct 不能自引用 → ✅ `class Node { let next: ?Node = None }`\n" +
			"- ❌ Option 直接 unwrap → ✅ 用 `??` 默认值或 match/if-let 安全解包\n"
		if (budget >= antiPatterns.length) {
			parts.push(antiPatterns)
			budget -= antiPatterns.length
		}
	}

	// Concurrency rules when using std.sync
	if (hasSyncImport) {
		const concurrencyRules =
			"### 并发注意事项\n" +
			"- spawn 块内不能直接捕获 `var` 变量\n" +
			"- 共享可变状态必须使用 Mutex/AtomicInt 保护\n" +
			"- 使用 `synchronized` 块或 `mutex.lock()/unlock()` 确保互斥\n"
		if (budget >= concurrencyRules.length) {
			parts.push(concurrencyRules)
			budget -= concurrencyRules.length
		}
	}

	// Workspace workflow when it's a multi-module project
	if (isWorkspace) {
		const wsWorkflow =
			"### Workspace 项目规则\n" +
			"- `[workspace]` 和 `[package]` 不能在同一 cjpm.toml\n" +
			"- 模块间依赖: `{ path = \"../module_name\" }` 写在子模块的 `[dependencies]`\n" +
			"- `cjpm run --name <模块>` 运行指定模块\n" +
			"- 每个模块需独立的 cjpm.toml 和 src/ 目录\n"
		if (budget >= wsWorkflow.length) {
			parts.push(wsWorkflow)
			budget -= wsWorkflow.length
		}
	}

	if (parts.length === 0) return null
	return parts.join("\n")
}

let projectOverviewCache: { key: string; value: string | null; time: number } | null = null
type HeavyContextBundle = {
	symbols: string | null
	importedSymbols: string | null
	stdlibHints: string | null
	workspaceSummary: string | null
	fewShot: string | null
}

let heavyContextCache: { key: string; value: HeavyContextBundle; time: number } | null = null
let contextSectionCache: { key: string; value: string; time: number } | null = null
/** Concurrent builds for the same full context key share one async computation. */
const contextSectionInFlightByKey = new Map<string, Promise<string>>()
const PROJECT_OVERVIEW_CACHE_TTL_MS = 60_000
const HEAVY_CONTEXT_CACHE_TTL_MS = 30_000

let l3TtlConfigCache: { value: number; fetchedAt: number } | null = null
const L3_TTL_CONFIG_CACHE_MS = 30_000

/** Call when workspace configuration may have changed (e.g. from extension `onDidChangeConfiguration`). */
export function bumpCangjieL3TtlConfigCache(): void {
	l3TtlConfigCache = null
}

function getContextSectionCacheTtlMs(): number {
	const now = Date.now()
	if (l3TtlConfigCache && now - l3TtlConfigCache.fetchedAt < L3_TTL_CONFIG_CACHE_MS) {
		return l3TtlConfigCache.value
	}
	const v = vscode.workspace.getConfiguration(Package.name).get<number>("cangjieContext.l3CacheTtlMs")
	const value = typeof v === "number" && v >= LIMITS.CANGJIE_L3_CACHE_TTL_MIN_MS && v <= LIMITS.CANGJIE_L3_CACHE_TTL_MAX_MS ? Math.floor(v) : LIMITS.CANGJIE_L3_CACHE_TTL_DEFAULT_MS
	l3TtlConfigCache = { value, fetchedAt: now }
	return value
}

/** Call when workspace `.njust_ai/rules-cangjie/` (or equivalent) changes so the next prompt rebuild picks up edits. */
export function invalidateCangjieContextSectionCache(): void {
	projectOverviewCache = null
	heavyContextCache = null
	contextSectionCache = null
	contextSectionInFlightByKey.clear()
	styleFewShotCache = null
	hoverMemo = null
	contextFileLru.clear()
	packageTreeCache.clear()
	cjpmTomlMetaCache.clear()
}

/** Invalidate only the assembled full-context cache (e.g. on save) — lighter than {@link invalidateCangjieContextSectionCache}. */
export function invalidateCangjieL3ContextCache(): void {
	contextSectionCache = null
	contextSectionInFlightByKey.clear()
}

/**
 * Default max tokens (~chars/4) for the dynamic Cangjie context block.
 *
 * Effective budget is resolved by `resolveCangjieContextTokenBudget` in system.ts:
 * VS Code config (override) > model-scaled value from
 * `deriveCangjieContextTokenBudgetFromContextWindow` > this default.
 *
 * Small-context models (e.g. 16k window) may receive as low as 2400 tokens;
 * large-context models (>= 200k) get up to 6000.
 */
export const DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET = 4800

/** BM25: at most this many chunks per source file per query (diversifies hits). */
const CORPUS_BM25_MAX_CHUNKS_PER_PATH = 2

function isWordCodePoint(cp: number): boolean {
	return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95
}

function isCjkCodePoint(cp: number): boolean {
	return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
}

/** Punctuation counted as +1 token (aligned with previous RegExp bracket set). */
function isCountedPunctCodePoint(cp: number): boolean {
	return (
		cp === 60 ||
		cp === 62 ||
		cp === 123 ||
		cp === 125 ||
		cp === 40 ||
		cp === 41 ||
		cp === 91 ||
		cp === 93 ||
		cp === 46 ||
		cp === 44 ||
		cp === 58 ||
		cp === 59 ||
		cp === 61 ||
		cp === 43 ||
		cp === 45 ||
		cp === 42 ||
		cp === 47 ||
		cp === 33 ||
		cp === 63 ||
		cp === 124 ||
		cp === 38
	)
}

function isWhitespaceCodePoint(cp: number): boolean {
	return cp === 32 || cp === 9 || cp === 10 || cp === 11 || cp === 12 || cp === 13 || cp === 0xa0
}

function estimateContextTokens(text: string): number {
	if (!text) return 0
	let estimate = 0
	let wordRun = 0
	for (let i = 0; i < text.length; ) {
		const cp = text.codePointAt(i)!
		const adv = cp > 0xffff ? 2 : 1
		if (isCjkCodePoint(cp)) {
			if (wordRun > 0) {
				estimate += Math.ceil(wordRun * 1.3)
				wordRun = 0
			}
			estimate += 1.5
			i += adv
			continue
		}
		if (isWordCodePoint(cp)) {
			wordRun++
			i += adv
			continue
		}
		if (wordRun > 0) {
			estimate += Math.ceil(wordRun * 1.3)
			wordRun = 0
		}
		if (isCountedPunctCodePoint(cp)) {
			estimate += 1
		} else if (!isWhitespaceCodePoint(cp)) {
			estimate += 0.4
		}
		i += adv
	}
	if (wordRun > 0) estimate += Math.ceil(wordRun * 1.3)
	return Math.max(0, Math.ceil(estimate))
}

export function estimateCangjieContextTokensForTest(text: string): number {
	return estimateContextTokens(text)
}

/** Exported for unit tests (learned-fix similarity normalization). */
export function testNormalizeLearnedFixText(text: string): string {
	return normalizeForSimilarity(text)
}

/** Exported for unit tests — single synthetic diagnostic. */
export function testLearnedFixPatternMatchesMessage(
	p: LearnedFixPattern,
	diagnosticMessage: string,
	diagnosticCode?: string,
): boolean {
	const d = {
		message: diagnosticMessage,
		severity: vscode.DiagnosticSeverity.Error,
		range: new vscode.Range(0, 0, 0, 0),
		...(diagnosticCode !== undefined ? { code: diagnosticCode } : {}),
	} as vscode.Diagnostic
	return learnedPatternMatchesDiagnostics(p, [d])
}

interface PrioritizedCangjieSection {
	priority: number
	content: string
}

interface CangjiePackBudgetOptions {
	rawErrorCount?: number
	totalDiagnosticCount?: number
	diagnosticSectionMinTokens?: number
}

/**
 * Section merge order under token budget (lower priority number is packed first).
 * Spaced by hundreds so new sections can slot between without renumbering everything.
 *
 * | Band | Role |
 * |------|------|
 * | 100 | Current diagnostics → doc/fix hints |
 * | 105 | Recent compile history (cjpm build evolution) |
 * | 200 | Structured editing context (cursor file) |
 * | 300 | Project learned-fixes.json |
 * | 400–415 | Symbols, import resolution, stdlib API hints |
 * | 500–530 | cjpm project, package tree, workspace modules, deps, cjpm tree, cross-module symbols |
 * | 600 | Import → corpus doc mapping |
 * | 700 | Dynamic contextual coding rules |
 * | 800 | BM25 corpus auto-injection |
 * | 850 | Corpus extra/ few-shot |
 * | 900 | Workspace style few-shot |
 *
 * Mandatory corpus footer is appended after packing (not in this list).
 */
function addPrioritized(
	bucket: PrioritizedCangjieSection[],
	priority: number,
	content: string | null | undefined,
): void {
	if (content) bucket.push({ priority, content })
}

function buildMandatoryCorpusFooter(docsBase: string | null | undefined, docsExist: boolean): string {
	if (!docsBase || !docsExist) return ""
	const corpusRootPosix = docsBase.replace(/\\/g, "/")
	return (
		`## 语料检索（强制）\n` +
			`内置语料根（**read_file** / **search_files** 须使用此绝对路径或其子路径）：\`${corpusRootPosix}\`。\n` +
			`动笔前检索 \`${corpusRootPosix}/manual/source_zh_cn/\` 与 \`${corpusRootPosix}/libs/\`；完整流程见模式说明「主动式语料检索」。`
	)
}

/** Greedy pack by ascending priority; reserve space for mandatory footer. */
function packSectionsWithTokenBudget(
	items: PrioritizedCangjieSection[],
	mandatoryFooter: string,
	budgetTokens: number,
	packOpts?: CangjiePackBudgetOptions,
): string[] {
	const footer = mandatoryFooter.trim()
	const reserve = footer ? estimateContextTokens(footer) : 0
	const pool = Math.max(0, budgetTokens - reserve)
	const errN = packOpts?.rawErrorCount ?? 0
	const totalD = packOpts?.totalDiagnosticCount ?? 0
	const density =
		totalD > 0 ? Math.min(1, errN / Math.max(10, totalD * 0.4)) : Math.min(1, errN / 6)
	const highFrac = Math.min(0.3, Math.max(0.15, 0.15 + 0.15 * density))
	let highPriorityReserve = Math.floor(pool * highFrac)
	const diagFloor = packOpts?.diagnosticSectionMinTokens ?? 0
	if (diagFloor > 0 && errN > 0) {
		highPriorityReserve = Math.max(highPriorityReserve, Math.min(diagFloor, Math.floor(pool * 0.42)))
	}
	let remaining = pool
	const sorted = [...items].sort((a, b) => a.priority - b.priority)
	// Pre-compute token estimates once per section to avoid redundant calculation in multi-pass packing
	const tokenEstimates = new Map<PrioritizedCangjieSection, number>()
	for (const s of sorted) tokenEstimates.set(s, estimateContextTokens(s.content))
	let splitIdx = sorted.length
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i].priority >= 300) {
			splitIdx = i
			break
		}
	}
	const highPriority = splitIdx === sorted.length ? sorted : sorted.slice(0, splitIdx)
	const normalPriority = splitIdx === sorted.length ? [] : sorted.slice(splitIdx)
	const out: string[] = []
	const usedSections = new Set<PrioritizedCangjieSection>()
	let highBudget = Math.min(highPriorityReserve, remaining)
	for (const s of highPriority) {
		const need = tokenEstimates.get(s)!
		if (need <= highBudget) {
			out.push(s.content)
			usedSections.add(s)
			remaining -= need
			highBudget -= need
		}
	}
	for (const s of normalPriority) {
		const need = tokenEstimates.get(s)!
		if (need <= remaining) {
			out.push(s.content)
			usedSections.add(s)
			remaining -= need
		}
	}
	for (const s of highPriority) {
		if (usedSections.has(s)) continue
		const need = tokenEstimates.get(s)!
		if (need <= remaining) {
			out.push(s.content)
			usedSections.add(s)
			remaining -= need
		}
	}
	if (footer) out.push(footer)
	return out
}

function simpleHash(str: string): number {
	let h = 0
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0
	}
	return h >>> 0
}

function computeContextCacheKey(cwd: string, diagSummaryHash: number): string {
	const openFiles = vscode.window.visibleTextEditors
		.filter((e) => e.document.languageId === "cangjie" || e.document.fileName.endsWith(".cj"))
		.map((e) => editorDocumentCacheKey(e.document.uri))
		.sort()
		.join("|")
	return `${cwd}|${openFiles}|${diagSummaryHash}|ch:${getCompileHistoryRevision(cwd)}`
}

function findCjpmTomlAncestor(startDir: string, maxHops = 10): string | null {
	let dir = path.resolve(startDir)
	for (let i = 0; i < maxHops; i++) {
		const toml = path.join(dir, "cjpm.toml")
		if (fs.existsSync(toml)) return toml
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

function workspaceHasOpenCangjieFile(): boolean {
	const docs = vscode.workspace.textDocuments ?? []
	for (const doc of docs) {
		if (doc.uri.scheme !== "file") continue
		if (doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) {
			return true
		}
	}
	return false
}

function openCangjieDocumentsSignature(): string {
	const docs = vscode.workspace.textDocuments ?? []
	const keys: string[] = []
	for (const doc of docs) {
		if (doc.uri.scheme !== "file") continue
		if (doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) {
			keys.push(editorDocumentCacheKey(doc.uri))
		}
	}
	return keys.sort().join("|")
}

/** 用户消息中是否出现仓颉工具链 / 语言相关关键词（Ask/Architect 注入语料时用）。 */
const USER_MESSAGE_CANGJIE_HINT = /\b(cjpm|cjc|cjfmt|cjlint|cjdb|cjprof|cjcov)\b|仓颉|\.cj\b|cangjie/i

export function userMessageSuggestsCangjie(text: string | undefined): boolean {
	if (!text) return false
	if (text.length > 400_000) return false
	return USER_MESSAGE_CANGJIE_HINT.test(text)
}

/**
 * Ask / Architect 下是否应附加与 Cangjie Dev 相同的动态语料（含语料库检索与工程上下文）。
 */
export function detectCangjieRelevanceForAuxiliaryModes(cwd: string, lastUserText?: string): boolean {
	if (workspaceHasOpenCangjieFile()) return true
	if (findCjpmTomlAncestor(cwd) != null) return true
	if (userMessageSuggestsCangjie(lastUserText)) return true
	return false
}

/**
 * 系统提示缓存键片段：Cangjie Dev 恒为 `cj`；Ask/Architect 在命中相关性时为 `on|...`，否则 `off`。
 */
export function getCangjieSystemPromptCacheKeySuffix(cwd: string, mode: string, lastUserHint?: string): string {
	if (mode === "cangjie") return "cj"
	if (mode !== "ask" && mode !== "architect") return "na"
	if (!detectCangjieRelevanceForAuxiliaryModes(cwd, lastUserHint)) return "off"
	const fp = `${openCangjieDocumentsSignature()}|${findCjpmTomlAncestor(cwd) ?? "-"}|${simpleHash(lastUserHint ?? "")}`
	return `on|${fp}`
}

// StructuredEditingContextPreparse is now imported from ./CangjieSymbolExtractor
export type { StructuredEditingContextPreparse } from "./CangjieSymbolExtractor"

/**
 * Generate the Cangjie context section for the system prompt.
 * Included for mode `cangjie`, and for `ask` / `architect` when
 * {@link detectCangjieRelevanceForAuxiliaryModes} is true (same corpus pipeline as Cangjie Dev).
 */
export async function getCangjieContextSection(
	cwd: string,
	mode: string,
	extensionPath?: string,
	tokenBudget: number = DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET,
	globalStoragePath?: string,
	lastUserHintForRelevance?: string,
	contextIntensity: CangjieContextIntensity = "full",
	recentBuildRootCauses: string[] = [],
	repairDirective?: string,
): Promise<string> {
	const runCangjieContext =
		mode === "cangjie" ||
		((mode === "ask" || mode === "architect") &&
			detectCangjieRelevanceForAuxiliaryModes(cwd, lastUserHintForRelevance))
	if (!runCangjieContext) return ""

	const diagSnapshot = collectDiagnosticSnapshot()
	const contextSectionKey = `${computeContextCacheKey(cwd, diagSnapshot.diagSummaryHash)}|tb:${tokenBudget}|m:${mode}|intensity:${contextIntensity}|rc:${simpleHash(recentBuildRootCauses.join("|"))}|rd:${simpleHash(repairDirective ?? "")}`
	const now = Date.now()
	const contextSectionTtl = getContextSectionCacheTtlMs()
	if (contextSectionCache && contextSectionCache.key === contextSectionKey && now - contextSectionCache.time < contextSectionTtl) {
		return contextSectionCache.value
	}

	const inflight = contextSectionInFlightByKey.get(contextSectionKey)
	if (inflight) return inflight

	const p = (async (): Promise<string> => {
	const docsBase = resolveCangjieDocsBasePath(extensionPath)
	const docsExist = docsBase != null && fs.existsSync(docsBase)
	const includeHeavyContext = contextIntensity === "full"

	const prioritized: PrioritizedCangjieSection[] = []
	let treeSectionPromise: Promise<string | null> = Promise.resolve(null)

	const activeFileInfo = _getActiveCangjieFileInfo()

		// 0a. Project structure context (cjpm.toml) - L1 cache
	const { info: projectInfo, cjpmRawHash } = await parseCjpmTomlWithMeta(cwd)
		if (projectInfo) {
		const projectOverviewKey = `${cwd}|${cjpmRawHash}|active:${activeFileInfo?.packageName ?? "-"}`
		let overview = projectOverviewCache && projectOverviewCache.key === projectOverviewKey && now - projectOverviewCache.time < PROJECT_OVERVIEW_CACHE_TTL_MS
			? projectOverviewCache.value
			: null
		if (overview === null) {
			overview = buildCompactProjectOverviewSection(
				cwd,
				projectInfo,
				activeFileInfo?.packageName ?? null,
				activeFileInfo?.filePath ?? null,
			)
			projectOverviewCache = { key: projectOverviewKey, value: overview, time: now }
		}
		addPrioritized(prioritized, 490, overview)
	}

	// 0b. package declaration verification + cjpm tree
	if (projectInfo && includeHeavyContext) {
		if (!projectInfo.isWorkspace) {
			const rootPkgName = projectInfo.name || undefined
			const pkgTree = getCachedPackageHierarchy(cwd, projectInfo.srcDir, rootPkgName)
			if (pkgTree) {
				const pkgMismatches = verifyPackageDeclarations(pkgTree, cwd, projectInfo.srcDir)
				addPrioritized(prioritized, 515, pkgMismatches || undefined)
			}
		} else {
			for (const member of projectInfo.members || []) {
				const memberCwd = path.join(cwd, member.path)
				const memberTree = getCachedPackageHierarchy(memberCwd, "src", member.name)
				if (memberTree) {
					const pkgMismatches = verifyPackageDeclarations(memberTree, memberCwd, "src")
					addPrioritized(prioritized, 515, pkgMismatches || undefined)
				}
			}
		}

		// cjpm tree — started in parallel; awaited below
		treeSectionPromise = getCjpmTreeSection(cwd)
	}

	// Collect imports + symbols from visible editors (single pass)
	const { imports, symbols: editorSymbolsSnapshot, activePreparse } = _collectActiveCangjieEditorSnapshot()
	const rawDiagnostics = diagSnapshot.allCjDiags
	const rawErrorCount = rawDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length

	// Symbol scanning, import analysis, and doc mapping are only performed
	// when a cjpm.toml project exists, to keep context lightweight otherwise.
	if (projectInfo && includeHeavyContext) {
		const idx = CangjieSymbolIndex.getInstance()
		const importsHash = simpleHash([...imports].sort().join("|"))
		const learnedFixesMtime = getLearnedFixesFileMtime(cwd)
		const heavyContextKey = [
			cwd,
			`idx:${idx?.fileCount ?? 0}:${idx?.symbolCount ?? 0}`,
			`imports:${imports.length}:${importsHash}`,
			`lf:${learnedFixesMtime}`,
			`ws:${projectInfo.isWorkspace ? 1 : 0}`,
		].join("::")
		let heavyBundle: HeavyContextBundle | null = null
		if (heavyContextCache && heavyContextCache.key === heavyContextKey && now - heavyContextCache.time < HEAVY_CONTEXT_CACHE_TTL_MS) {
			heavyBundle = heavyContextCache.value
		} else {
			heavyBundle = {
				symbols: editorSymbolsSnapshot,
				importedSymbols: _resolveImportedSymbols(imports, cwd, projectInfo),
				stdlibHints: buildStdlibSignatureHintsSection(imports, docsBase, globalStoragePath),
				workspaceSummary: projectInfo.isWorkspace ? buildWorkspaceSymbolSummary(projectInfo, cwd) : null,
				fewShot: buildCangjieStyleFewShotSection(cwd, imports, rawDiagnostics, cjpmRawHash),
			}
			heavyContextCache = { key: heavyContextKey, value: heavyBundle, time: now }
		}
		addPrioritized(prioritized, 380, heavyBundle.symbols || undefined)
		addPrioritized(prioritized, 390, heavyBundle.importedSymbols || undefined)
		addPrioritized(prioritized, 395, heavyBundle.stdlibHints || undefined)
		if (includeHeavyContext) {
			addPrioritized(prioritized, 528, heavyBundle.workspaceSummary || undefined)
		}

		// 1. Import-based documentation context
		if (includeHeavyContext && imports.length > 0 && docsBase && docsExist) {
			const docMappings = _mapImportsToDocPaths(imports)
			if (docMappings.length > 0) {
				const importContext = docMappings
					.map((m) => {
						const paths = m.docPaths.map((p) => p.replace(/\\/g, "/")).join(", ")
						return `- \`${m.prefix}\`: ${m.summary} (请视需检索: ${paths})`
					})
					.join("\n")

				addPrioritized(
					prioritized,
					350,
					`## 当前代码涉及的重要模块映射\n\n当前代码中已引入以下高级模块。若后续编写代码缺乏十足把握，强烈建议立刻使用 \`search_files\`（regex 搜索）检索这些官方库示例：\n\n${importContext}`,
				)
			}
		}
	}

	const diagSample = sampleCangjieDiagnostics(rawDiagnostics)
	const diagnostics = diagSample.sampled
	const conversionByMessage = buildConversionHintByMessage(diagnostics)
	const errorSections =
		diagnostics.length > 0 && docsBase && docsExist
			? mapDiagnosticsToDocContext(diagnostics, docsBase, conversionByMessage)
			: []

	if (includeHeavyContext) {
		addPrioritized(prioritized, 95, formatCompileHistoryPromptSection(cwd))
	}

	if (recentBuildRootCauses.length > 0) {
		addPrioritized(
			prioritized,
			92,
			`## Recent Cangjie Build Root Causes\n- ${recentBuildRootCauses.slice(0, 4).join("\n- ")}`,
		)
	}

	if (repairDirective) {
		addPrioritized(prioritized, 93, `## Cangjie Compile-Repair Directive\n${repairDirective}`)
	}

	// 1b. Dynamic coding rules injection (context-aware).
	addPrioritized(
		prioritized,
		650,
		buildContextualCodingRules(imports, projectInfo, rawDiagnostics, errorSections.length > 0) ||
			undefined,
	)
	if (includeHeavyContext) {
		addPrioritized(prioritized, 850, heavyContextCache?.value.fewShot || undefined)
	}

	// 2. Error/diagnostic context (sampled + merged messages for prompt), kept late in final order.
	let diagnosticSection: string | null = null
	if (errorSections.length > 0) {
		const omitNote =
			diagSample.omitted > 0
				? `\n\n_共 ${diagSample.total} 条诊断，以上展示经重要性筛选与消息合并；另有 ${diagSample.omitted} 条未列出。_`
				: ""
		diagnosticSection = `## 当前诊断错误与修复建议\n\n检测到以下编译/检查错误，建议参考对应文档修复：\n\n${errorSections.join("\n")}${omitNote}`
		const aug = buildDiagnosticAugmentationLines(diagnostics, cwd, conversionByMessage, diagSnapshot.byFile)
		if (aug.length > 0) {
			diagnosticSection += `\n\n### 辅助定位（根因/类型转换）\n${aug.join("\n")}`
		}
		addPrioritized(prioritized, 90, diagnosticSection)
	}

	// 2a. Intent-matched few-shot from bundled corpus extra/
	if (includeHeavyContext && docsBase && docsExist) {
		addPrioritized(
			prioritized,
			750,
			buildCorpusExtraFewShotSection(docsBase, imports, rawDiagnostics) || undefined,
		)
	}

	// 2b. Auto-inject corpus search results based on imports and diagnostics
	if (includeHeavyContext && docsBase && docsExist) {
		try {
			const corpusIndex = getCorpusSingleton(docsBase)
			if (corpusIndex.isAvailable) {
				const queries = buildAutoCorpusQueries(imports, diagnostics)
				const unique = new Map<string, { hit: import("../../../services/cangjie-corpus/CangjieCorpusSemanticIndex").SemanticSearchResult; score: number }>()
				const searchOpts = { maxChunksPerPath: CORPUS_BM25_MAX_CHUNKS_PER_PATH }
				const hitLists =
					queries.length > 0
						? corpusIndex.searchBatch(queries, 12, undefined, searchOpts)
						: []
				for (let qi = 0; qi < hitLists.length; qi++) {
					const hits = hitLists[qi]!
					const maxS = hits.reduce((m, h) => Math.max(m, h.score), 0)
					for (const h of hits) {
						const norm = maxS > 0 ? h.score / maxS : 0
						const key = `${h.relPath}:${h.startLine}`
						const prev = unique.get(key)
						if (!prev || prev.score < norm) {
							unique.set(key, { hit: h, score: norm })
						}
					}
				}
				const top = [...unique.values()].sort((a, b) => b.score - a.score).slice(0, 7).map((x) => x.hit)
				if (top.length > 0) {
					const hints = top.map((h) =>
						`### ${h.heading}\n来源: \`${h.relPath}\` (L${h.startLine})\n\`\`\`\n${h.snippet.slice(0, 800)}\n\`\`\``
					).join("\n\n")
					addPrioritized(
						prioritized,
						550,
						`## 语料库自动检索结果（基于当前 import 与诊断）\n\n${hints}`,
					)
				}
			}
		} catch {
			// corpus unavailable — no injection
		}
	}

	const mandatoryFooter = buildMandatoryCorpusFooter(docsBase, docsExist)

	// 4. Structured editing context + awaiting parallel promises
	const activeEd = vscode.window.activeTextEditor
	let structuredPre: StructuredEditingContextPreparse | undefined
	if (activeEd && (activeEd.document.languageId === "cangjie" || activeEd.document.fileName.endsWith(".cj"))) {
		structuredPre = activePreparse
			? { ...activePreparse, diagnosticsByFile: diagSnapshot.byFile }
			: (() => {
				const c = activeEd.document.getText()
				return {
					content: c,
					lines: c.split("\n"),
					imports: _extractImports(c),
					defs: parseCangjieDefinitions(c),
					diagnosticsByFile: diagSnapshot.byFile,
				}
			})()
	}
	const [editingCtx, treeSection] = await Promise.all([
		buildStructuredEditingContext(structuredPre),
		treeSectionPromise,
	])
	addPrioritized(prioritized, 525, treeSection || undefined)
	addPrioritized(prioritized, 150, editingCtx || undefined)

	// 5. Project-curated learned fixes (optional JSON in .njust_ai/)
	addPrioritized(prioritized, 250, loadLearnedFixesSection(cwd, rawDiagnostics) || undefined)

	const diagTokensEstimate = diagnosticSection ? estimateContextTokens(diagnosticSection) : 0
	const packed = packSectionsWithTokenBudget(prioritized, mandatoryFooter, Math.max(500, tokenBudget), {
		rawErrorCount,
		totalDiagnosticCount: rawDiagnostics.length,
		diagnosticSectionMinTokens:
			rawErrorCount > 0 ? Math.min(Math.max(diagTokensEstimate, 480), 1200) : 0,
	})
	if (diagnosticSection) {
		const idx = packed.indexOf(diagnosticSection)
		if (idx >= 0) {
			packed.splice(idx, 1)
			packed.push(diagnosticSection)
		}
	}
	if (packed.length === 0) return ""

	const auxiliaryNote =
		mode === "ask" || mode === "architect"
			? "\n（以下仓颉语料与工程上下文仅供查阅；请保持当前 Ask/Architect 模式的角色与职责。）"
			: ""

	const result = `====

CANGJIE DEVELOPMENT CONTEXT${auxiliaryNote}

${packed.join("\n\n")}
`
	contextSectionCache = { value: result, key: contextSectionKey, time: Date.now() }
	return result
	})()
	contextSectionInFlightByKey.set(contextSectionKey, p)
	void p.finally(() => contextSectionInFlightByKey.delete(contextSectionKey))
	return p
}

/**
 * Extract file:line:col references from cjc error output and read surrounding
 * source lines to provide richer context for AI-assisted fixes.
 */
const ERROR_CONTEXT_RADIUS = 15
const ERROR_CONTEXT_MAX_LOCATIONS = 8

function formatSingleErrorLocationBlock(cwd: string, filePart: string, lineStr: string): string | null {
	const lineNum = parseInt(lineStr, 10) - 1
	if (Number.isNaN(lineNum) || lineNum < 0) return null
	const filePath = path.isAbsolute(filePart) ? filePart : path.resolve(cwd, filePart)
	try {
		if (!fs.existsSync(filePath)) return null
		const content = fs.readFileSync(filePath, "utf-8")
		const lines = content.split("\n")
		const start = Math.max(0, lineNum - ERROR_CONTEXT_RADIUS)
		const end = Math.min(lines.length, lineNum + ERROR_CONTEXT_RADIUS + 1)

		const snippet = lines
			.slice(start, end)
			.map((l, i) => {
				const num = start + i + 1
				const marker = num === lineNum + 1 ? " >>>" : "    "
				return `${marker} ${num}: ${l}`
			})
			.join("\n")

		const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
		let block = `文件: ${relPath} (第 ${lineNum + 1} 行)\n${snippet}`

		// Include file's import list for context
		if (filePath.endsWith(".cj")) {
			const fileImports = _extractImports(content)
			if (fileImports.length > 0) {
				block += `\n  文件 import: ${fileImports.slice(0, 12).join(", ")}${fileImports.length > 12 ? " …" : ""}`
			}
		}

		const symbolIndex = CangjieSymbolIndex.getInstance()
		if (symbolIndex && filePath.endsWith(".cj")) {
			const enclosing = symbolIndex.findEnclosingSymbol(filePath, lineNum)
			if (enclosing?.signature) {
				block += `\n  所在符号: ${enclosing.kind} ${enclosing.name}\n  签名: ${enclosing.signature}`
			}
		}

		return block
	} catch {
		return null
	}
}

function extractErrorSourceContext(errorOutput: string, cwd: string): string[] {
	const locationRe = /==>\s+(.+?):(\d+):(\d+):/g
	const contextLines: string[] = []
	const seen = new Set<string>()
	let match: RegExpExecArray | null

	while ((match = locationRe.exec(errorOutput)) !== null) {
		const [, filePart, lineStr] = match
		const lineNum = parseInt(lineStr, 10) - 1
		const filePath = path.isAbsolute(filePart!) ? filePart! : path.resolve(cwd, filePart!)
		const key = `${filePath}:${lineNum}`
		if (seen.has(key)) continue
		seen.add(key)

		const block = formatSingleErrorLocationBlock(cwd, filePart!, lineStr!)
		if (block) contextLines.push(block)

		if (contextLines.length >= ERROR_CONTEXT_MAX_LOCATIONS) break
	}

	if (contextLines.length >= ERROR_CONTEXT_MAX_LOCATIONS) {
		contextLines.push("（已达单段上下文展示上限；其余错误位置请查看完整编译输出。）")
	}

	return contextLines
}

/**
 * Enhance a cjc/cjlint error message with documentation references and fix suggestions.
 * Called when terminal output contains compilation errors.
 */
export function enhanceCjcErrorOutput(errorOutput: string, cwd: string, extensionPath?: string): string {
	const docsBase = resolveCangjieDocsBasePath(extensionPath)
	const docsExist = docsBase != null && fs.existsSync(docsBase)

	const matchedSuggestions: string[] = []

	for (const pattern of getMatchingCjcPatternsByCategory(errorOutput)) {
		const docPaths =
			docsBase && docsExist ? pattern.docPaths.map((p) => path.join(docsBase, p).replace(/\\/g, "/")).join(", ") : ""
		const ref = docPaths ? ` (参考: ${docPaths})` : ""
		const directive = pattern.fixDirective ?? pattern.suggestion
		matchedSuggestions.push(`[${pattern.category}] ${pattern.suggestion}${ref}\n  AI 修复指令: ${directive}`)
	}

	const sourceContexts = extractErrorSourceContext(errorOutput, cwd)

	if (matchedSuggestions.length === 0 && sourceContexts.length === 0) return ""

	const parts: string[] = []
	if (sourceContexts.length > 0) {
		parts.push(`出错位置源码:\n${sourceContexts.join("\n\n")}`)
	}
	if (matchedSuggestions.length > 0) {
		parts.push(matchedSuggestions.join("\n"))
	}

	return `\n\n<cangjie_error_hints>\n${parts.join("\n\n")}\n</cangjie_error_hints>`
}

const EXEC_CMD_ERROR_MAX_PATTERNS_PER_BLOCK = 5

/**
 * Single appendix for **execute_command** on cjpm/cjc failure: either per-`==>` blocks with
 * nearby source + pattern hints (no duplicate tail blob), or {@link enhanceCjcErrorOutput} when
 * the output has no `==>` headers.
 */
export function buildCangjieExecuteCommandErrorAppendix(
	output: string,
	cwd: string,
	extensionPath?: string,
): string {
	const normalized = output.replace(/\r\n/g, "\n")
	if (!/==>\s+/.test(normalized)) {
		return enhanceCjcErrorOutput(output, cwd, extensionPath)
	}

	const docsBase = resolveCangjieDocsBasePath(extensionPath)
	const docsExist = docsBase != null && fs.existsSync(docsBase)
	const lines = normalized.split("\n")
	const isLocationLine = (line: string) => /^==>\s+.+:\d+:\d+:/.test(line.trim())

	const blocks: string[][] = []
	let cur: string[] = []
	for (const line of lines) {
		if (isLocationLine(line) && cur.length > 0) {
			blocks.push(cur)
			cur = [line]
		} else {
			cur.push(line)
		}
	}
	if (cur.length) blocks.push(cur)

	const sections: string[] = []
	for (const block of blocks) {
		const text = block.join("\n").trimEnd()
		if (!text) continue

		const firstNonEmpty = block.map((l) => l.trim()).find(Boolean) ?? ""
		const locMatch = firstNonEmpty.match(/^==>\s+(.+?):(\d+):(\d+):/)
		const header = locMatch
			? `[${locMatch[1]} 第 ${locMatch[2]} 行 col ${locMatch[3]}]`
			: "[输出片段]"

		const snippet =
			locMatch != null ? formatSingleErrorLocationBlock(cwd, locMatch[1], locMatch[2]) : null

		const patterns = getMatchingCjcPatternsByCategory(text)
		let patternBlock: string
		if (patterns.length > 0) {
			patternBlock = patterns
				.slice(0, EXEC_CMD_ERROR_MAX_PATTERNS_PER_BLOCK)
				.map((pattern) => {
					const docPathsStr =
						docsBase && docsExist
							? pattern.docPaths.map((p) => path.join(docsBase, p).replace(/\\/g, "/")).join(", ")
							: ""
					const ref = docPathsStr ? ` (参考: ${docPathsStr})` : ""
					const directive = pattern.fixDirective ?? pattern.suggestion
					return `[${pattern.category}] ${pattern.suggestion}${ref}\n  AI 修复指令: ${directive}`
				})
				.join("\n\n")
		} else {
			patternBlock = `（未匹配已知错误模式）\n→ 启发式建议: ${_getErrorFixDirective(text)}`
		}

		const pieces = [`### ${header}`, "```", text, "```"]
		if (snippet) {
			pieces.push("出错位置源码:", snippet)
		}
		pieces.push("修复建议（本段输出）:", patternBlock)
		sections.push(pieces.join("\n"))
	}

	if (sections.length === 0) {
		return enhanceCjcErrorOutput(output, cwd, extensionPath)
	}

	// Repair priority footer: guide the LLM to fix errors in the optimal order
	const repairPriority =
		"\n\n**修复优先级建议**: " +
		"1. import/符号错误（级联根因，修复后其他错误可能消失） → " +
		"2. 类型不匹配/泛型约束 → " +
		"3. mut/let 限制 → " +
		"4. 语法/格式错误"

	// Failure accumulation hint for repeated compile failures
	const errorCount = blocks.length
	const failureHint = errorCount > 5
		? `\n\n⚠ 检测到 ${errorCount} 处错误。建议集中修复最可能是根因的 import/符号问题，而非逐个修复所有错误。修复根因后重新编译，观察剩余错误是否减少。`
		: ""

	return `\n\n<cangjie_error_hints>\n按错误位置就近整理（每段含编译原文、源码上下文与建议）:\n\n${sections.join("\n\n---\n\n")}${repairPriority}${failureHint}\n</cangjie_error_hints>`
}

// Error fix directives are now defined in CangjieErrorAnalyzer.ts; re-export here.
export const getErrorFixDirective = _getErrorFixDirective

// ---------------------------------------------------------------------------
// Structured AI editing context
// ---------------------------------------------------------------------------

/** Align with Cangjie Dev plan: 1000ms cap (typical hover <500ms). */
const HOVER_PROVIDER_TIMEOUT_MS = 1000
const HOVER_TEXT_MAX_CHARS = 4000
const HOVER_POSITION_MEMO_TTL_MS = 1000
let hoverMemo: { key: string; value: string | null; time: number } | null = null

function hoversToPlainText(hovers: vscode.Hover[]): string {
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
async function fetchHoverAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
): Promise<string | null> {
	const hoverEnabled = vscode.workspace.getConfiguration("njust-ai-cj").get<boolean>("cangjieLsp.enabled", true)
	if (!hoverEnabled) return null
	const key = `${document.uri.toString()}:${position.line}:${position.character}`
	const now = Date.now()
	if (hoverMemo && hoverMemo.key === key && now - hoverMemo.time < HOVER_POSITION_MEMO_TTL_MS) {
		return hoverMemo.value
	}
	try {
		const task = vscode.commands.executeCommand(
			"vscode.executeHoverProvider",
			document.uri,
			position,
		) as Thenable<vscode.Hover[] | undefined>

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
	const defs = usePre ? pre.defs : parseCangjieDefinitions(content)
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
		.filter((d: CangjieDef) => d.startLine <= cursorLine && d.endLine >= cursorLine && d.kind !== "import" && d.kind !== "package")
		.sort((a: CangjieDef, b: CangjieDef) => (b.startLine - a.startLine))

	if (enclosing.length > 0) {
		const innermost = enclosing[0]
		const sig = computeCangjieSignature(lines, innermost)
		if (enclosing.length > 1) {
			const outermost = enclosing[enclosing.length - 1]
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
						const memberSig = computeCangjieSignature(lines, m)
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
		const errorSummary = errors.slice(0, 5).map((d) => {
			const directive = getErrorFixDirectiveForDiagnostic(d)
			return `  - 第 ${d.range.start.line + 1} 行: ${d.message}\n    建议: ${directive}`
		}).join("\n")
		parts.push(`当前文件错误:\n${errorSummary}`)
	}

	return `## 当前编辑上下文\n\n${parts.join("\n")}`
}

/**
 * After a cjpm/cjc compile failure, automatically search the bundled corpus
 * for documentation relevant to the error categories detected in the output.
 * Returns a formatted block to append to the tool_result, or null.
 */
export function buildCompileErrorCorpusSearch(
	compileOutput: string,
	cwd: string,
	extensionPath?: string,
): string | null {
	const docsBase = resolveCangjieDocsBasePath(extensionPath)
	if (!docsBase || !fs.existsSync(docsBase)) return null

	try {
		const corpusIndex = getCorpusSingleton(docsBase)
		if (!corpusIndex.isAvailable) return null

		const matchedPatterns = getMatchingCjcPatternsByCategory(compileOutput)
		if (matchedPatterns.length === 0) return null

		const queries = matchedPatterns
			.slice(0, 4)
			.map((p) => `${p.category} 修复 示例`)

		const searchOpts = { maxChunksPerPath: 2 }
		const hitLists = corpusIndex.searchBatch(queries, 8, undefined, searchOpts)

		const unique = new Map<string, { hit: import("../../../services/cangjie-corpus/CangjieCorpusSemanticIndex").SemanticSearchResult; score: number }>()
		for (let qi = 0; qi < hitLists.length; qi++) {
			const hits = hitLists[qi]!
			const maxS = hits.reduce((m, h) => Math.max(m, h.score), 0)
			for (const h of hits) {
				const norm = maxS > 0 ? h.score / maxS : 0
				const key = `${h.relPath}:${h.startLine}`
				const prev = unique.get(key)
				if (!prev || prev.score < norm) {
					unique.set(key, { hit: h, score: norm })
				}
			}
		}

		const top = [...unique.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, 3)
			.map((x) => x.hit)

		if (top.length === 0) return null

		const COMPILE_CORPUS_MAX_CHARS = 1200
		let used = 0
		const snippets: string[] = []
		for (const h of top) {
			const snippet = `### ${h.heading}\n来源: \`${h.relPath}\`\n\`\`\`\n${h.snippet.slice(0, 400)}\n\`\`\``
			if (used + snippet.length > COMPILE_CORPUS_MAX_CHARS) break
			snippets.push(snippet)
			used += snippet.length
		}

		if (snippets.length === 0) return null

		return (
			`\n\n<cangjie_corpus_for_error>\n` +
			`## 编译错误相关语料参考（自动检索）\n\n` +
			`以下文档片段与当前编译错误相关，可参考修复：\n\n` +
			snippets.join("\n\n") +
			`\n</cangjie_corpus_for_error>`
		)
	} catch {
		return null
	}
}

// Re-export for testing and backward compatibility
export {
	_extractImports,
	_mapImportsToDocPaths,
	CJC_ERROR_PATTERNS,
	STDLIB_DOC_MAP,
	matchCjcErrorPattern,
	getMatchingCjcPatternsByCategory,
	parseCjpmToml,
	scanPackageHierarchy,
	_resolveImportedSymbols,
	verifyPackageDeclarations,
	buildWorkspaceSymbolSummary,
}
export type { CjcErrorPattern, DocMapping }
