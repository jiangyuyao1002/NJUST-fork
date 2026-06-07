// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as path from "path"
import * as fs from "fs"

import { STDLIB_DOC_MAP as _STDLIB_DOC_MAP } from "../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import { CangjieSymbolIndex, type SymbolEntry } from "../../../services/cangjie-lsp/CangjieSymbolIndex"
import { extractCangjieImportPackagePrefixes } from "../../../services/cangjie-lsp/cangjieImportPaths"
import { extractTypeMemberSummaries } from "../../../services/tree-sitter/cangjieParser"

const STDLIB_DOC_MAP = _STDLIB_DOC_MAP

export interface CjpmProjectInfoLike {
	name: string
	isWorkspace: boolean
	members?: Array<{ name: string; path: string }>
	srcDir: string
}

const IMPORT_DOC_MAPPING_MAX_ITEMS = 3
const MAX_IMPORT_SYMBOLS = 60
const MAX_SYMBOLS_PER_PACKAGE = 15
const TYPE_OUTLINE_MAX_LINES = 40
const TYPE_OUTLINE_MAX_CHARS = 1200
const MAX_TYPE_OUTLINES_PER_IMPORT_BLOCK = 4
const TYPE_MEMBER_DISPLAY_MAX = 8

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

export function extractImports(content: string): string[] {
	return extractCangjieImportPackagePrefixes(content)
}

export function isNonTrivialImportMapping(prefix: string): boolean {
	return !(prefix === "std.core" || prefix.startsWith("std.core."))
}

export function mapImportsToDocPaths(
	imports: string[],
): Array<{ prefix: string; summary: string; docPaths: string[] }> {
	const results: Array<{ prefix: string; summary: string; docPaths: string[] }> = []
	const seen = new Set<string>()

	for (const imp of imports) {
		for (const mapping of STDLIB_DOC_MAP) {
			if (imp.startsWith(mapping.prefix) && !seen.has(mapping.prefix)) {
				seen.add(mapping.prefix)
				results.push(mapping)
			}
		}
	}

	const nonTrivial = results.filter((r) => isNonTrivialImportMapping(r.prefix))
	return nonTrivial.slice(0, IMPORT_DOC_MAPPING_MAX_ITEMS)
}

export function resolveImportToDirectory(
	importPath: string,
	cwd: string,
	rootName: string,
	srcDir: string,
	projectInfo: CjpmProjectInfoLike | null,
): string | null {
	const segments = importPath.split(".")

	if (projectInfo?.isWorkspace && projectInfo.members) {
		const memberMatch = projectInfo.members.find((m) => m.name === segments[0])
		if (memberMatch) {
			const memberCwd = path.join(cwd, memberMatch.path)
			const subPath = segments.slice(1).join(path.sep)
			const candidate = subPath ? path.join(memberCwd, "src", subPath) : path.join(memberCwd, "src")
			if (fs.existsSync(candidate)) return candidate
		}
	}

	if (rootName && segments[0] === rootName) {
		const subPath = segments.slice(1).join(path.sep)
		const candidate = subPath ? path.join(cwd, srcDir, subPath) : path.join(cwd, srcDir)
		if (fs.existsSync(candidate)) return candidate
	}

	const directPath = segments.join(path.sep)
	const candidate = path.join(cwd, srcDir, directPath)
	if (fs.existsSync(candidate)) return candidate

	return null
}

export function extractTypeOutlineFromLines(lines: string[], sym: SymbolEntry): string | null {
	if (!["class", "struct", "interface", "enum"].includes(sym.kind)) return null
	const from = sym.startLine
	const to = Math.min(sym.endLine, sym.startLine + TYPE_OUTLINE_MAX_LINES - 1)
	let slice = lines.slice(from, to + 1).join("\n")
	slice = slice.replace(/[ \t]+\n/g, "\n").trim()
	if (slice.length > TYPE_OUTLINE_MAX_CHARS) {
		return `${slice.slice(0, TYPE_OUTLINE_MAX_CHARS)}…`
	}
	return slice
}

export function formatSymbolEntries(symbols: SymbolEntry[], cwd: string): string[] {
	const lines: string[] = []
	const grouped = new Map<string, SymbolEntry[]>()

	for (const sym of symbols) {
		const relFile = path.relative(cwd, sym.filePath).replace(/\\/g, "/")
		if (!grouped.has(relFile)) grouped.set(relFile, [])
		grouped.get(relFile)!.push(sym)
	}

	let outlineBudget = MAX_TYPE_OUTLINES_PER_IMPORT_BLOCK
	const fileLinesCache = new Map<string, string[]>()

	for (const [file, syms] of grouped) {
		for (const sym of syms) {
			const vis = sym.visibility && sym.visibility !== "internal" ? `${sym.visibility} ` : ""
			const sig = sym.signature ? `: \`${sym.signature}\`` : ""
			const tp = sym.typeParams ? ` ${sym.typeParams}` : ""
			lines.push(`- ${vis}${sym.kind}${tp} **${sym.name}**${sig} _(${file}:${sym.startLine + 1})_`)
			if (outlineBudget <= 0 || !["class", "struct", "interface", "enum"].includes(sym.kind)) {
				continue
			}
			try {
				let fileLines = fileLinesCache.get(sym.filePath)
				if (!fileLines) {
					const text = readFileUtf8Lru(sym.filePath)
					if (!text) continue
					fileLines = text.split("\n")
					fileLinesCache.set(sym.filePath, fileLines)
				}
				const summary = extractTypeMemberSummaries(
					fileLines,
					sym.startLine,
					sym.endLine,
					TYPE_MEMBER_DISPLAY_MAX + 4,
				)
				if (summary.members.length > 0) {
					outlineBudget--
					const omitted =
						summary.totalMatchingLines > TYPE_MEMBER_DISPLAY_MAX
							? `（共约 ${summary.totalMatchingLines} 个成员样例行，以下分类摘要）`
							: ""
					const rows: string[] = []
					if (summary.properties.length) {
						rows.push(`    属性/字段: ${summary.properties.slice(0, 6).join(" | ")}`)
					}
					if (summary.methods.length) {
						rows.push(`    方法: ${summary.methods.slice(0, 6).join(" | ")}`)
					}
					if (summary.operators.length) {
						rows.push(`    运算符: ${summary.operators.join(" | ")}`)
					}
					if (summary.inits.length) {
						rows.push(`    构造: ${summary.inits.join(" | ")}`)
					}
					if (summary.enumCases.length) {
						rows.push(`    枚举/分支: ${summary.enumCases.slice(0, 8).join(" | ")}`)
					}
					if (rows.length === 0) {
						const display = summary.members.slice(0, TYPE_MEMBER_DISPLAY_MAX)
						for (const l of display) rows.push(`    ${l}`)
					}
					lines.push(`    - 成员概要${omitted}:\n${rows.join("\n")}`)
				} else {
					const outline = extractTypeOutlineFromLines(fileLines, sym)
					if (outline) {
						outlineBudget--
						const indented = outline
							.split("\n")
							.map((l) => `      ${l}`)
							.join("\n")
						lines.push(`    - 类型头/成员草稿:\n${indented}`)
					}
				}
			} catch {
				/* skip */
			}
		}
	}

	return lines
}

export function resolveImportedSymbols(
	imports: string[],
	cwd: string,
	projectInfo: CjpmProjectInfoLike | null,
): string | null {
	const symbolIndex = CangjieSymbolIndex.getInstance()
	if (!symbolIndex || symbolIndex.symbolCount === 0) return null

	const localImports = imports.filter((imp) => !imp.startsWith("std."))
	if (localImports.length === 0) return null

	const rootName = projectInfo?.name || ""
	const srcDir = projectInfo?.srcDir || "src"

	const sections: string[] = []
	let totalSymbols = 0

	for (const imp of localImports) {
		if (totalSymbols >= MAX_IMPORT_SYMBOLS) break

		const dirPath = resolveImportToDirectory(imp, cwd, rootName, srcDir, projectInfo)
		if (!dirPath) continue

		const symbols = symbolIndex.getSymbolsByDirectory(dirPath)
		if (symbols.length === 0) continue

		const publicSymbols = symbols.slice(0, MAX_SYMBOLS_PER_PACKAGE)
		const lines = formatSymbolEntries(publicSymbols, cwd)
		if (lines.length === 0) continue

		sections.push(`**${imp}** (${path.relative(cwd, dirPath).replace(/\\/g, "/")}/):\n${lines.join("\n")}`)
		totalSymbols += publicSymbols.length
	}

	if (sections.length === 0) return null

	return `## 已导入的工作区模块符号\n\n以下是当前文件 import 的本地包中的符号定义，可直接在代码中引用：\n\n${sections.join("\n\n")}`
}
