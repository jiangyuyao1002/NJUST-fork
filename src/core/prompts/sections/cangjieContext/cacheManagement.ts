import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

import { Package } from "../../../../shared/package"
import { LIMITS } from "../../../../shared/constants"
import { getCompileHistoryRevision } from "../../../../services/cangjie-lsp/cangjieCompileHistory"
import { simpleHash } from "./budget"

const CONTEXT_FILE_LRU_MAX = 64
const contextFileLru = new Map<string, { mtime: number; text: string }>()

export async function readFileUtf8Lru(fp: string): Promise<string | null> {
	try {
		const st = await fs.promises.stat(fp)
		const hit = contextFileLru.get(fp)
		if (hit && hit.mtime === st.mtimeMs) return hit.text
		const text = await fs.promises.readFile(fp, "utf-8")
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

export async function editorDocumentCacheKey(uri: vscode.Uri): Promise<string> {
	const fp = uri.fsPath
	if (uri.scheme !== "file") return fp
	try {
		return `${fp}:${(await fs.promises.stat(fp)).mtimeMs}`
	} catch {
		return fp
	}
}

export type HeavyContextBundle = {
	symbols: string | null
	importedSymbols: string | null
	stdlibHints: string | null
	workspaceSummary: string | null
	fewShot: string | null
}

let projectOverviewCache: { key: string; value: string | null; time: number } | null = null
let heavyContextCache: { key: string; value: HeavyContextBundle; time: number } | null = null
let contextSectionCache: { key: string; value: string; time: number } | null = null
const contextSectionInFlightByKey = new Map<string, Promise<string>>()
const PROJECT_OVERVIEW_CACHE_TTL_MS = 60_000
const HEAVY_CONTEXT_CACHE_TTL_MS = 30_000

let l3TtlConfigCache: { value: number; fetchedAt: number } | null = null
const L3_TTL_CONFIG_CACHE_MS = 30_000

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

export function invalidateCangjieContextSectionCacheState(): void {
	projectOverviewCache = null
	heavyContextCache = null
	contextSectionCache = null
	contextSectionInFlightByKey.clear()
	contextFileLru.clear()
}

export function invalidateCangjieL3ContextCacheState(): void {
	contextSectionCache = null
	contextSectionInFlightByKey.clear()
}

export async function computeContextCacheKey(cwd: string, diagSummaryHash: number): Promise<string> {
	const openFilesPromises = vscode.window.visibleTextEditors
		.filter((e) => e.document.languageId === "cangjie" || e.document.fileName.endsWith(".cj"))
		.map((e) => editorDocumentCacheKey(e.document.uri))
	const openFiles = (await Promise.all(openFilesPromises))
		.sort()
		.join("|")
	return `${cwd}|${openFiles}|${diagSummaryHash}|ch:${getCompileHistoryRevision(cwd)}`
}

export function findCjpmTomlAncestor(startDir: string, maxHops = 10): string | null {
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

async function openCangjieDocumentsSignature(): Promise<string> {
	const docs = vscode.workspace.textDocuments ?? []
	const keysPromises: Promise<string>[] = []
	for (const doc of docs) {
		if (doc.uri.scheme !== "file") continue
		if (doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) {
			keysPromises.push(editorDocumentCacheKey(doc.uri))
		}
	}
	const keys = await Promise.all(keysPromises)
	return keys.sort().join("|")
}

const USER_MESSAGE_CANGJIE_HINT = /\b(cjpm|cjc|cjfmt|cjlint|cjdb|cjprof|cjcov)\b|\.cj\b|cangjie/i

export function userMessageSuggestsCangjie(text: string | undefined): boolean {
	if (!text) return false
	if (text.length > 400_000) return false
	return USER_MESSAGE_CANGJIE_HINT.test(text) || text.includes("\u4ed3\u9889")
}

export function detectCangjieRelevanceForAuxiliaryModes(cwd: string, lastUserText?: string): boolean {
	if (workspaceHasOpenCangjieFile()) return true
	if (findCjpmTomlAncestor(cwd) != null) return true
	if (userMessageSuggestsCangjie(lastUserText)) return true
	return false
}

export function getCangjieSystemPromptCacheKeySuffix(cwd: string, mode: string, lastUserHint?: string): string {
	if (mode === "cangjie") return "cj"
	if (mode !== "ask" && mode !== "architect") return "na"
	if (!detectCangjieRelevanceForAuxiliaryModes(cwd, lastUserHint)) return "off"
	const fp = `${openCangjieDocumentsSignature()}|${findCjpmTomlAncestor(cwd) ?? "-"}|${simpleHash(lastUserHint ?? "")}`
	return `on|${fp}`
}

export function getCachedProjectOverview(key: string, now: number): string | null {
	return projectOverviewCache && projectOverviewCache.key === key && now - projectOverviewCache.time < PROJECT_OVERVIEW_CACHE_TTL_MS
		? projectOverviewCache.value
		: null
}

export function setCachedProjectOverview(key: string, value: string | null, now: number): void {
	projectOverviewCache = { key, value, time: now }
}

export function getCachedHeavyContext(key: string, now: number): HeavyContextBundle | null {
	return heavyContextCache && heavyContextCache.key === key && now - heavyContextCache.time < HEAVY_CONTEXT_CACHE_TTL_MS
		? heavyContextCache.value
		: null
}

export function setCachedHeavyContext(key: string, value: HeavyContextBundle, now: number): void {
	heavyContextCache = { key, value, time: now }
}

export function getCachedContextSection(key: string, now: number): string | null {
	const contextSectionTtl = getContextSectionCacheTtlMs()
	return contextSectionCache && contextSectionCache.key === key && now - contextSectionCache.time < contextSectionTtl
		? contextSectionCache.value
		: null
}

export function setCachedContextSection(key: string, value: string): void {
	contextSectionCache = { value, key, time: Date.now() }
}

export function getContextSectionInFlight(key: string): Promise<string> | undefined {
	return contextSectionInFlightByKey.get(key)
}

export function setContextSectionInFlight(key: string, value: Promise<string>): void {
	contextSectionInFlightByKey.set(key, value)
}

export function deleteContextSectionInFlight(key: string): void {
	contextSectionInFlightByKey.delete(key)
}
