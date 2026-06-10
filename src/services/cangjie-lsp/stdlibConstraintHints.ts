import * as fs from "fs"
import * as path from "path"

// Agent-facing stdlib constraint hints for AI prompts — intentionally kept in Chinese (not i18n'd)

export interface StdlibConstraintCacheFile {
	corpusTag: string
	extracted: Record<string, string>
}

const STDLIB_CONSTRAINT_MEM_CACHE_TTL_MS = 30_000
let stdlibConstraintMemCache: {
	baseHash: number
	corpusRoot: string
	globalStoragePath: string
	corpusTag: string
	value: Record<string, string>
	time: number
} | null = null

function simpleHash(str: string): number {
	let h = 0
	for (let i = 0; i < str.length; i++) {
		h = ((h << 5) - h + str.charCodeAt(i)) | 0
	}
	return h >>> 0
}

function corpusTagForRoot(corpusRoot: string): string {
	try {
		if (!fs.existsSync(corpusRoot)) return "missing"
		const base = path.basename(corpusRoot)
		const st = fs.statSync(corpusRoot)
		return `${base}:${st.mtimeMs}:${simpleHash(corpusRoot)}`
	} catch {
		return "err"
	}
}

function walkMarkdownFiles(dir: string, out: string[]): void {
	if (!fs.existsSync(dir)) return
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const e of entries) {
		const p = path.join(dir, e.name)
		if (e.isDirectory()) {
			if (e.name.startsWith(".") || e.name === "target") continue
			walkMarkdownFiles(p, out)
		} else if (e.name.endsWith(".md")) {
			out.push(p)
		}
	}
}

function inferStdPrefixFromCorpusPath(corpusRoot: string, filePath: string): string | null {
	const posixRoot = corpusRoot.replace(/\\/g, "/")
	const posixFile = filePath.replace(/\\/g, "/")
	const stdIdx = posixFile.indexOf("/libs/std/")
	if (stdIdx >= 0) {
		const rest = posixFile.slice(stdIdx + "/libs/std/".length)
		const seg = rest.split("/")[0]
		if (seg) return `std.${seg}`
	}
	if (posixFile.includes("/manual/") && posixFile.includes("/generic")) {
		return "std.collection"
	}
	if (posixRoot && posixFile.startsWith(posixRoot)) {
		const rel = posixFile.slice(posixRoot.length).replace(/^\//, "")
		if (rel.startsWith("libs/std/")) {
			const parts = rel.split("/")
			if (parts.length >= 3) return `std.${parts[2]}`
		}
	}
	return null
}

/**
 * 从语料库 .md 中收集含 where / <: 约束的行，按 std.* 前缀聚合（启发式）。
 */
export function extractWhereConstraintsFromCorpus(corpusRoot: string): Record<string, string> {
	const merged: Record<string, string[]> = {}
	const files: string[] = []
	const scanDirs = [
		path.join(corpusRoot, "libs/std/collection"),
		path.join(corpusRoot, "libs/std/core"),
		path.join(corpusRoot, "manual/source_zh_cn/generic"),
	].filter((d) => fs.existsSync(d))

	for (const d of scanDirs) {
		walkMarkdownFiles(d, files)
	}

	for (const fp of files) {
		let text: string
		try {
			text = fs.readFileSync(fp, "utf-8")
		} catch {
			continue
		}
		const lines = text.split("\n")
		const hits: string[] = []
		for (const line of lines) {
			const t = line.trim()
			if (!/\bwhere\b/i.test(t) && !/<:/.test(t)) continue
			if (!/<:/.test(t)) continue
			const cleaned = t.replace(/\s+/g, " ").slice(0, 220)
			if (cleaned.length > 12) hits.push(cleaned)
		}
		if (hits.length === 0) continue
		const key = inferStdPrefixFromCorpusPath(corpusRoot, fp)
		if (!key) continue
		const prev = merged[key] ?? []
		prev.push(...hits.slice(0, 2))
		merged[key] = prev
	}

	const out: Record<string, string> = {}
	for (const [k, arr] of Object.entries(merged)) {
		const uniq = [...new Set(arr)].slice(0, 4)
		if (uniq.length > 0) out[k] = `约束摘录: ${uniq.join(" | ")}`
	}
	return out
}

/**
 * 将语料提取的泛型/where 约束合并进静态摘要；缓存到 globalStoragePath。
 */
export function mergeStdlibConstraintHintsFromCorpus(
	baseHints: Record<string, string>,
	corpusRoot: string,
	globalStoragePath: string,
): Record<string, string> {
	const now = Date.now()
	const baseHash = simpleHash(JSON.stringify(baseHints))
	if (
		stdlibConstraintMemCache &&
		now - stdlibConstraintMemCache.time < STDLIB_CONSTRAINT_MEM_CACHE_TTL_MS &&
		stdlibConstraintMemCache.baseHash === baseHash &&
		stdlibConstraintMemCache.corpusRoot === corpusRoot &&
		stdlibConstraintMemCache.globalStoragePath === globalStoragePath
	) {
		return stdlibConstraintMemCache.value
	}

	const tag = corpusTagForRoot(corpusRoot)
	if (
		stdlibConstraintMemCache &&
		stdlibConstraintMemCache.baseHash === baseHash &&
		stdlibConstraintMemCache.corpusRoot === corpusRoot &&
		stdlibConstraintMemCache.globalStoragePath === globalStoragePath &&
		stdlibConstraintMemCache.corpusTag === tag
	) {
		stdlibConstraintMemCache.time = now
		return stdlibConstraintMemCache.value
	}

	const cachePath = path.join(globalStoragePath, "njust-ai-stdlib-constraints.json")
	try {
		if (fs.existsSync(cachePath)) {
			const raw = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as StdlibConstraintCacheFile
			if (raw.corpusTag === tag && raw.extracted && typeof raw.extracted === "object") {
				const value = { ...baseHints, ...raw.extracted }
				stdlibConstraintMemCache = {
					baseHash,
					corpusRoot,
					globalStoragePath,
					corpusTag: tag,
					value,
					time: now,
				}
				return value
			}
		}
	} catch {
		// intentionally ignored: cache refresh failure
	}

	const extracted = extractWhereConstraintsFromCorpus(corpusRoot)
	try {
		fs.mkdirSync(globalStoragePath, { recursive: true })
		fs.writeFileSync(cachePath, JSON.stringify({ corpusTag: tag, extracted }, null, 2), "utf-8")
	} catch {
		// intentionally ignored: cache write failure is non-fatal
	}
	const value = { ...baseHints, ...extracted }
	stdlibConstraintMemCache = {
		baseHash,
		corpusRoot,
		globalStoragePath,
		corpusTag: tag,
		value,
		time: now,
	}
	return value
}
