// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
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
export const CORPUS_BM25_MAX_CHUNKS_PER_PATH = 2

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

export function estimateContextTokens(text: string): number {
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

export interface PrioritizedCangjieSection {
	priority: number
	content: string
}

export interface CangjiePackBudgetOptions {
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
export function addPrioritized(
	bucket: PrioritizedCangjieSection[],
	priority: number,
	content: string | null | undefined,
): void {
	if (content) bucket.push({ priority, content })
}

export function buildMandatoryCorpusFooter(docsBase: string | null | undefined, docsExist: boolean): string {
	if (!docsBase || !docsExist) return ""
	const corpusRootPosix = docsBase.replace(/\\/g, "/")
	return (
		`## 语料检索（强制）\n` +
		`内置语料根（**read_file** / **search_files** 须使用此绝对路径或其子路径）：\`${corpusRootPosix}\`。\n` +
		`动笔前检索 \`${corpusRootPosix}/manual/source_zh_cn/\` 与 \`${corpusRootPosix}/libs/\`；完整流程见模式说明「主动式语料检索」。`
	)
}

/** Greedy pack by ascending priority; reserve space for mandatory footer. */
export function packSectionsWithTokenBudget(
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
	const density = totalD > 0 ? Math.min(1, errN / Math.max(10, totalD * 0.4)) : Math.min(1, errN / 6)
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
		if (sorted[i]!.priority >= 300) {
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

export function simpleHash(str: string): number {
	let h = 0
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0
	}
	return h >>> 0
}
