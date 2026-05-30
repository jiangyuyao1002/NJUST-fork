import * as path from "path"
import * as fs from "fs"
import { NJUST_AI_CONFIG_DIR } from "@njust-ai/types"

export const LEARNED_FIXES_FILE = "learned-fixes.json"

export const LEARNED_FIXES_MAX_PATTERNS = 80

export interface LearnedFixPattern {
	errorPattern: string
	fix: string
	/** When set, match only diagnostics with this code (case-insensitive). */
	diagnosticCode?: string
	projectSpecific?: boolean
	occurrences?: number
	successCount?: number
	failCount?: number
	lastSeenAt?: string
}

export interface LearnedFixesFileData {
	patterns: LearnedFixPattern[]
}

export function getLearnedFixesJsonPath(cwd: string): string {
	return path.join(cwd, NJUST_AI_CONFIG_DIR, LEARNED_FIXES_FILE)
}

const learnedFixesLoadCache = new Map<string, { mtimeMs: number; data: LearnedFixesFileData }>()

/** Drop in-memory parse cache (all workspaces or one resolved json path). */
export function invalidateLearnedFixesMemoryCache(cwd?: string): void {
	if (cwd === undefined) {
		learnedFixesLoadCache.clear()
		return
	}
	learnedFixesLoadCache.delete(path.resolve(getLearnedFixesJsonPath(cwd)))
}

/** mtimeMs for cache keys; 0 if file missing */
export function getLearnedFixesFileMtime(cwd: string): number {
	const fp = getLearnedFixesJsonPath(cwd)
	try {
		if (!fs.existsSync(fp)) return 0
		return fs.statSync(fp).mtimeMs
	} catch {
		return 0
	}
}

export function loadLearnedFixes(cwd: string): LearnedFixesFileData {
	const fp = path.resolve(getLearnedFixesJsonPath(cwd))
	const empty: LearnedFixesFileData = { patterns: [] }
	try {
		if (!fs.existsSync(fp)) {
			learnedFixesLoadCache.delete(fp)
			return empty
		}
		const st = fs.statSync(fp)
		const hit = learnedFixesLoadCache.get(fp)
		if (hit && hit.mtimeMs === st.mtimeMs) {
			return hit.data
		}
		const raw = fs.readFileSync(fp, "utf-8")
		const parsed = JSON.parse(raw) as unknown
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as LearnedFixesFileData).patterns)) {
			const data = parsed as LearnedFixesFileData
			learnedFixesLoadCache.set(fp, { mtimeMs: st.mtimeMs, data })
			return data
		}
	} catch {
		learnedFixesLoadCache.delete(fp)
	}
	return empty
}

export function saveLearnedFixes(cwd: string, data: LearnedFixesFileData): void {
	const dir = path.join(cwd, NJUST_AI_CONFIG_DIR)
	const fp = path.resolve(getLearnedFixesJsonPath(cwd))
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
	}
	fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8")
	try {
		const st = fs.statSync(fp)
		learnedFixesLoadCache.set(fp, { mtimeMs: st.mtimeMs, data })
	} catch {
		learnedFixesLoadCache.delete(fp)
	}
}

/** Create an empty learned-fixes.json if missing (for “open in editor” UX). */
export function ensureLearnedFixesFile(cwd: string): void {
	const fp = getLearnedFixesJsonPath(cwd)
	if (!fs.existsSync(fp)) {
		saveLearnedFixes(cwd, { patterns: [] })
	}
}
