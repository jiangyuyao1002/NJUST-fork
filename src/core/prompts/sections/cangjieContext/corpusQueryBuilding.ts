// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

import { CangjieCorpusSemanticIndex } from "../../../../services/cangjie-corpus/CangjieCorpusSemanticIndex"
import { getMatchingCjcPatternsByCategory } from "../../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import { mergeStdlibConstraintHintsFromCorpus } from "../../../../services/cangjie-lsp/stdlibConstraintHints"
import { resolveCangjieDocsBasePath } from "../CangjieDocsResolver"
import { resolveCjcPatternForDiagnostic as _resolveCjcPatternForDiagnostic } from "../CangjieErrorAnalyzer"
import { STDLIB_API_SIGNATURE_HINTS, STDLIB_CRITICAL_SIGNATURES } from "./stdlibSignatures"
import { CORPUS_BM25_MAX_CHUNKS_PER_PATH } from "./budget"
import { readFileUtf8Lru } from "./cacheManagement"
import { logger } from "../../../../shared/logger"

let corpusSingleton: { instance: CangjieCorpusSemanticIndex; root: string } | null = null

function getCorpusSingleton(corpusRoot: string): CangjieCorpusSemanticIndex {
	if (corpusSingleton && corpusSingleton.root === corpusRoot) {
		return corpusSingleton.instance
	}
	const instance = new CangjieCorpusSemanticIndex(corpusRoot)
	corpusSingleton = { instance, root: corpusRoot }
	return instance
}

const resolveCjcPatternForDiagnostic = _resolveCjcPatternForDiagnostic

export function importPathToCorpusQuery(imp: string): string | null {
	const parts = imp.split(".").filter((p) => p && p !== "*")
	if (parts.length === 0) return null
	if (parts.length === 1) return parts[0]!
	return `${parts[parts.length - 2]!} ${parts[parts.length - 1]!}`
}

/** Short query from diagnostic: prefer CJC pattern category + trimmed message; else keyword heuristic. */
export function diagnosticToCorpusQuery(d: vscode.Diagnostic): string | null {
	const raw = d.message.replace(/[`'"]/g, " ").replace(/\s+/g, " ").trim()
	if (!raw) return null
	const resolved = resolveCjcPatternForDiagnostic(d)
	if (resolved) {
		const head = raw.split(/[:：，,。]/)[0]?.trim() ?? raw
		return `${resolved.category} ${head}`.slice(0, 120)
	}
	const cleaned = raw.replace(/^(error|warning)\s*[:\d[\]]*\s*/i, "")
	const words = cleaned.split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w) && !/^[|:=]+$/.test(w))
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

export function buildAutoCorpusQueries(imports: string[], diagnostics: vscode.Diagnostic[]): string[] {
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

export async function buildStdlibSignatureHintsSection(
	imports: string[],
	docsBase: string | null | undefined,
	globalStoragePath?: string,
): Promise<string | null> {
	let hints: Record<string, string> = STDLIB_API_SIGNATURE_HINTS
	if (docsBase && globalStoragePath) {
		try {
			await fs.promises.access(docsBase)
			hints = mergeStdlibConstraintHintsFromCorpus({ ...STDLIB_API_SIGNATURE_HINTS }, docsBase, globalStoragePath)
		} catch (error) {
			logger.debug("CorpusQueryBuilding", "corpus docs directory access failed", error)
			/* docsBase doesn't exist, use default hints */
		}
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
	const criticalBlock =
		criticalLines.length > 0 ? `\n\n## 标准库关键 API 签名（参数级精度）\n\n${criticalLines.join("\n\n")}` : ""

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
			} catch (error) {
				logger.debug("CorpusQueryBuilding", "regex compilation failed for corpus key", error)
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

export async function buildCorpusExtraFewShotSection(
	corpusRoot: string,
	imports: string[],
	diagnostics: vscode.Diagnostic[],
): Promise<string | null> {
	try {
		await fs.promises.access(corpusRoot)
	} catch {
		return null
	}

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
		try {
			await fs.promises.access(fp)
		} catch {
			continue
		}
		try {
			const raw = await readFileUtf8Lru(fp)
			if (!raw) continue
			let body = raw.trim().replace(/\r\n/g, "\n")
			if (body.length > CORPUS_EXTRA_MAX_CHARS_PER_FILE) {
				body = body.slice(0, CORPUS_EXTRA_MAX_CHARS_PER_FILE) + "\n…"
			}
			usedRel.add(rel)
			const title = path.basename(rel, ".md")
			picked.push(`### 语料示例: ${title}\n来源: \`${rel}\`\n\n${body}`)
		} catch (error) {
			logger.debug("CorpusQueryBuilding", "corpus file read failed", error)
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

export function buildAutoCorpusSearchSection(
	docsBase: string,
	imports: string[],
	diagnostics: vscode.Diagnostic[],
): string | null {
	try {
		const corpusIndex = getCorpusSingleton(docsBase)
		if (corpusIndex.isAvailable) {
			const queries = buildAutoCorpusQueries(imports, diagnostics)
			const unique = new Map<
				string,
				{
					hit: import("../../../../services/cangjie-corpus/CangjieCorpusSemanticIndex").SemanticSearchResult
					score: number
				}
			>()
			const searchOpts = { maxChunksPerPath: CORPUS_BM25_MAX_CHUNKS_PER_PATH }
			const hitLists = queries.length > 0 ? corpusIndex.searchBatch(queries, 12, undefined, searchOpts) : []
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
				.slice(0, 7)
				.map((x) => x.hit)
			if (top.length > 0) {
				const hints = top
					.map(
						(h) =>
							`### ${h.heading}\n来源: \`${h.relPath}\` (L${h.startLine})\n\`\`\`\n${h.snippet.slice(0, 800)}\n\`\`\``,
					)
					.join("\n\n")
				return `## 语料库自动检索结果（基于当前 import 与诊断）\n\n${hints}`
			}
		}
	} catch (error) {
		logger.debug("CorpusQueryBuilding", "corpus query building failed", error)
		// corpus unavailable - no injection
	}
	return null
}

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

		const queries = matchedPatterns.slice(0, 4).map((p) => `${p.category} 修复 示例`)

		const searchOpts = { maxChunksPerPath: 2 }
		const hitLists = corpusIndex.searchBatch(queries, 8, undefined, searchOpts)

		const unique = new Map<
			string,
			{
				hit: import("../../../../services/cangjie-corpus/CangjieCorpusSemanticIndex").SemanticSearchResult
				score: number
			}
		>()
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
			`\n\n====\n## Cangjie Corpus Reference\n\n` +
			`以下文档片段与当前编译错误相关，可参考修复：\n\n` +
			snippets.join("\n\n") +
			`\n====`
		)
	} catch {
		return null
	}
}
