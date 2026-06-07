// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"
import { NJUST_AI_CONFIG_DIR } from "@njust-ai/types"

import { CangjieSymbolIndex, type SymbolEntry } from "../../../../services/cangjie-lsp/CangjieSymbolIndex"
import { CJC_ERROR_PATTERNS } from "../../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import { normalizeDiagnosticCode as _normalizeDiagnosticCode } from "../CangjieErrorAnalyzer"
import { extractImports as _extractImports } from "../CangjieImportParser"
import {
	LEARNED_FIXES_FILE,
	LEARNED_FIXES_MAX_PATTERNS,
	type LearnedFixPattern,
	getLearnedFixesFileMtime,
	loadLearnedFixes,
	saveLearnedFixes,
} from "../learnedFixesStorage"
import { readFileUtf8Lru } from "./cacheManagement"
import { normalizeDiagnosticMessageForAggregation } from "./diagnosticHandling"

const LEARNED_FIXES_MAX_SECTION_CHARS = 4000
const normalizeDiagnosticCode = _normalizeDiagnosticCode

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

const STYLE_FEW_SHOT_MAX_CHARS = 2200
const STYLE_SNIPPET_LINES = 16
const STYLE_FEW_SHOT_CACHE_TTL_MS = 30_000
const STYLE_FEW_SHOT_MAX_PER_MODULE = 1

let styleFewShotCache: { key: string; value: string | null; time: number } | null = null

function topLevelModuleFromRel(rel: string): string {
	const normalized = rel.replace(/\\/g, "/")
	const segs = normalized.split("/")
	if (segs.length < 2) return normalized
	if (segs[0] === "src" && segs.length >= 3) return segs[1]!
	return segs[0]!
}

export async function buildCangjieStyleFewShotSection(
	cwd: string,
	imports: string[],
	diagnostics: vscode.Diagnostic[],
	cjpmRawHash: string,
): Promise<string | null> {
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
	if (
		styleFewShotCache &&
		styleFewShotCache.key === cacheKey &&
		now - styleFewShotCache.time < STYLE_FEW_SHOT_CACHE_TTL_MS
	) {
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
				const raw = await readFileUtf8Lru(sym.filePath)
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
			const block = "```cangjie\n" + `// ${sym.kind} ${sym.name} (${rel}:${from + 1})\n` + slice + "\n```"
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

export function normalizeForSimilarity(text: string): string {
	let s = text
		.replace(/\r\n/g, "\n")
		.toLowerCase()
		.replace(/^\[[^\]]*\]\s*/, "")
	s = s.replace(/[a-z]:[\\/][^:\s)]+/gi, "FILE")
	s = s.replace(/(?:\/[\w.-]+)+\.(?:cj|toml)/gi, "FILE")
	s = s.replace(/(?:[\w.-]+\\)+[\w.-]+\.(?:cj|toml)/gi, "FILE")
	s = s.replace(/:\d+:\d+/g, ":L:L")
	s = s.replace(/\bline\s+\d+\b/gi, "line L")
	s = s.replace(/(?<!\d):\d{1,6}(?!\d)/g, ":L")
	s = s.replace(/\s+/g, " ").trim()
	return s
}

export function countLearnedFixLexiconOverlap(normalizedErrorPattern: string, normalizedMessage: string): number {
	const epTok = new Set(normalizedErrorPattern.split(" ").filter((t) => t.length > 1))
	const msgTok = new Set(normalizedMessage.split(" ").filter((t) => t.length > 1))
	let n = 0
	for (const t of epTok) {
		if (LEARNED_FIX_CATEGORY_LEXICON.has(t) && msgTok.has(t)) n++
	}
	return n
}

export function levenshteinDistance(a: string, b: string): number {
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

export function stringSimilarity(a: string, b: string): number {
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
	return [m[0]!.toLowerCase(), m[1]!.toLowerCase()]
}

function primitiveTypeSetsEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false
	const sb = new Set(b)
	return a.every((t) => sb.has(t))
}

export function learnedPatternMatchesDiagnostics(p: LearnedFixPattern, diagnostics: vscode.Diagnostic[]): boolean {
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
		successCount: 5,
		failCount: 0,
	},
	{
		errorPattern: "type mismatch|类型不匹配",
		fix: "检查赋值/传参的类型是否一致。常见: String vs Int64 需显式转换 Int64.parse(str); ?T 需用 ?? 解包; Array<T> 与 ArrayList<T> 不直接兼容需构造。",
		successCount: 4,
		failCount: 0,
	},
	{
		errorPattern: "cannot call mut func on.*let|let.*调用.*mut",
		fix: "将 let 绑定改为 var 绑定。mut 方法只能在 var 绑定的 struct 实例上调用。示例: var counter = Counter() 然后 counter.inc()。",
		successCount: 5,
		failCount: 0,
	},
	{
		errorPattern: "recursive struct|struct.*自引用|infinite.*size",
		fix: "struct 是值类型不能自引用。改用 class（引用类型）或将自引用字段声明为 ?StructName（Option 包装）。",
		successCount: 3,
		failCount: 0,
	},
	{
		errorPattern: "non-exhaustive|match.*不穷尽|missing.*case",
		fix: "match 表达式必须覆盖所有可能分支。添加遗漏的 case 或使用 case _ => 作为兜底。对 enum 类型需要列出所有变体。",
		successCount: 4,
		failCount: 0,
	},
	{
		errorPattern: "main.*返回.*void|main.*return type",
		fix: "main 函数返回类型必须为 Int64，不能省略或使用其他类型。正确签名: main(): Int64 { ... return 0 }",
		successCount: 3,
		failCount: 0,
	},
	{
		errorPattern: "package.*不一致|package.*mismatch|package.*directory",
		fix: "package 声明必须与 src/ 下的目录结构严格对应。例如 src/foo/bar/baz.cj 中应为 package foo.bar。",
		successCount: 3,
		failCount: 0,
	},
	{
		errorPattern: "cannot find.*import|import.*not found",
		fix: "检查 import 路径是否正确。std 标准库用 import std.模块名.* 格式。项目内部包用 import 包名.* 且需在 cjpm.toml 中配置依赖。",
		successCount: 3,
		failCount: 0,
	},
	{
		errorPattern: "override.*not open|redef.*override",
		fix: "override 只能用于 open 修饰的父类方法；非 open 方法需用 redef 而非 override。检查父类方法声明是否有 open 修饰符。",
		successCount: 2,
		failCount: 0,
	},
	{
		errorPattern: "interface.*not implement|未实现.*接口",
		fix: "实现 interface 需要覆盖所有方法。用 class MyClass <: InterfaceName { public func methodName(...): ReturnType { ... } } 语法。",
		successCount: 2,
		failCount: 0,
	},
	{
		errorPattern: "HashMap.*Hashable|HashSet.*Hashable",
		fix: "HashMap 的 Key 类型须实现 Hashable & Equatable<K>。自定义类型用作 Key 需要 extend 实现这两个接口或使用已内置实现的类型(String, Int64 等)。",
		successCount: 3,
		failCount: 0,
	},
	{
		errorPattern: "spawn.*capture.*var|并发.*捕获.*可变",
		fix: "spawn 块内不能直接捕获外部 var 变量。使用 Mutex<T> 包装共享状态，或将值在 spawn 前拷贝到 let 绑定。",
		successCount: 2,
		failCount: 0,
	},
]

/**
 * Load project-specific error→fix hints from .njust_ai/learned-fixes.json (manual curation).
 * Falls back to BUILTIN_SEED_FIXES when no project file exists.
 * Prioritizes patterns matching current diagnostics and sorts by empirical success rate.
 */
export function loadLearnedFixesSection(cwd: string, diagnostics: vscode.Diagnostic[]): string | null {
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
				learnedPatternSuccessRate(a) * learnedPatternTimeWeight(a) || (b.failCount ?? 0) - (a.failCount ?? 0)
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
			const occ = typeof p.occurrences === "number" && p.occurrences > 0 ? `（约 ${p.occurrences} 次）` : ""
			const stats = s + f > 0 ? ` [验证 ${s} 成功 / ${f} 失败${f > s ? " · 低置信" : ""}]` : ""
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
export function recordLearnedFix(cwd: string, errorPattern: string, fix: string, projectSpecific = true): void {
	const data = loadLearnedFixes(cwd)

	// Normalize for dedup
	const normalizedPattern = errorPattern.trim().toLowerCase().slice(0, 300)

	// Check for existing match (dedup by error pattern similarity)
	const existing = data.patterns.find((p) => {
		const existingNorm = p.errorPattern.trim().toLowerCase().slice(0, 300)
		return (
			existingNorm === normalizedPattern ||
			existingNorm.includes(normalizedPattern) ||
			normalizedPattern.includes(existingNorm)
		)
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
		return (
			existingNorm === normalizedPattern ||
			existingNorm.includes(normalizedPattern) ||
			normalizedPattern.includes(existingNorm)
		)
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

/** Exported for unit tests (learned-fix similarity normalization). */
export function testNormalizeLearnedFixText(text: string): string {
	return normalizeForSimilarity(text)
}

/** Exported for unit tests - single synthetic diagnostic. */
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

export function invalidateLearnedFixMatchingCaches(): void {
	styleFewShotCache = null
}
