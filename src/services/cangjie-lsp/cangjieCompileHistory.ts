import * as path from "path"
import { createHash } from "crypto"
import { normalizeErrorPattern } from "./CangjieErrorAnalyzer"

const MAX_ENTRIES_PER_CWD = 5

export interface CompileHistoryErrorLine {
	file: string
	line: number
	message: string
	fingerprint: string
}

export interface CompileHistoryRecord {
	ts: number
	cwd: string
	success: boolean
	incremental: boolean
	durationMs: number
	errorCount: number
	errors: CompileHistoryErrorLine[]
}

const byCwd = new Map<string, CompileHistoryRecord[]>()
const revByCwd = new Map<string, number>()

function fingerprintMessage(message: string): string {
	const normalized = normalizeErrorPattern(message.slice(0, 500))
	return createHash("sha256").update(normalized).digest("hex").slice(0, 8)
}

function bumpRevision(cwd: string): void {
	revByCwd.set(cwd, (revByCwd.get(cwd) ?? 0) + 1)
}

/** Revision bumps on each compile end — included in Cangjie context cache key for freshness. */
export function getCompileHistoryRevision(cwd: string): number {
	return revByCwd.get(cwd) ?? 0
}

export function recordCompileHistoryEvent(payload: {
	cwd: string
	success: boolean
	incremental: boolean
	durationMs: number
	errorCount: number
	errors: Array<{ file: string; line: number; message: string }>
}): void {
	const errors: CompileHistoryErrorLine[] = payload.errors.map((e) => ({
		file: e.file,
		line: e.line,
		message: e.message,
		fingerprint: fingerprintMessage(e.message),
	}))

	const record: CompileHistoryRecord = {
		ts: Date.now(),
		cwd: payload.cwd,
		success: payload.success,
		incremental: payload.incremental,
		durationMs: payload.durationMs,
		errorCount: payload.errorCount,
		errors,
	}

	const list = byCwd.get(payload.cwd) ?? []
	list.push(record)
	while (list.length > MAX_ENTRIES_PER_CWD) {
		list.shift()
	}
	byCwd.set(payload.cwd, list)
	bumpRevision(payload.cwd)
}

// Agent-facing compile history prompt section — intentionally kept in Chinese (not i18n'd)
/** Markdown section for AI context (仓颉 Dev 模式). */
export function formatCompileHistoryPromptSection(cwd: string): string | null {
	const list = byCwd.get(cwd)
	if (!list || list.length === 0) return null

	const lines: string[] = [
		"## 本轮编译历史",
		"",
		"_最近若干次 cjpm build 的摘要（对比错误演进；以「当前诊断错误」与编辑器为准）。_",
		"",
	]

	for (const e of list) {
		const d = new Date(e.ts)
		const hh = String(d.getHours()).padStart(2, "0")
		const mm = String(d.getMinutes()).padStart(2, "0")
		const mode = e.incremental ? "增量" : "全量"
		const sec = (e.durationMs / 1000).toFixed(1)

		if (e.success) {
			lines.push(`- [${hh}:${mm}] ✅ 通过 (${mode}, ${sec}s)`)
			continue
		}

		lines.push(`- [${hh}:${mm}] ❌ 失败（${e.errorCount} 条, ${mode}, ${sec}s）`)
		const slice = e.errors.slice(0, 4)
		for (const er of slice) {
			const base = er.file === "-" ? "-" : path.basename(er.file)
			const msg = er.message.replace(/\s+/g, " ").trim().slice(0, 120)
			const loc = er.line > 0 ? `${base}:${er.line}` : base
			lines.push(`  - ${loc} — ${msg} — \`${er.fingerprint}\``)
		}
		if (e.errors.length > 4) {
			lines.push(`  - … 另有 ${e.errors.length - 4} 条`)
		}
	}

	return lines.join("\n")
}
