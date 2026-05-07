/**
 * Cangjie (.cj) source code parser that extracts definitions without tree-sitter.
 *
 * Two strategies are available:
 *  1. Regex-based heuristic parser (fast, no external dependency)
 *  2. `cjc --dump-ast` integration (optional, requires the Cangjie SDK)
 *
 * The regex parser is always used as the primary parser for
 * `parseSourceCodeDefinitionsForFile` (folded context).
 * The cjc-based parser is attempted first when configured; the regex
 * parser serves as the fallback.
 */

import * as vscode from "vscode"
import { execFile } from "child_process"
import { logger } from "../../shared/logger"
import { promisify } from "util"
import * as path from "path"
import * as fs from "fs"
import { QueryCapture } from "web-tree-sitter"
import { Package } from "../../shared/package"

const execFileAsync = promisify(execFile)

// ─── MockNode / MockCapture (same pattern as markdownParser.ts) ───

interface MockNode {
	startPosition: { row: number }
	endPosition: { row: number }
	text: string
	parent?: MockNode
}

interface MockCapture {
	node: MockNode
	name: string
	patternIndex: number
}

// ─── Definition types we look for ───

export type CangjieDefKind =
	| "class"
	| "struct"
	| "interface"
	| "enum"
	| "func"
	| "extend"
	| "type_alias"
	| "var"
	| "let"
	| "main"
	| "macro"
	| "package"
	| "import"
	| "prop"
	| "init"
	| "operator"
	| "enum_case"

export interface CangjieDef {
	kind: CangjieDefKind
	name: string
	startLine: number // 0-based
	endLine: number // 0-based
	signature?: string
}

export type CangjieSymbolVisibility = "public" | "internal" | "protected" | "private"

export interface CangjieDeclarationMeta {
	visibility: CangjieSymbolVisibility
	modifiers: string[]
	/** Generic parameter list including angle brackets, e.g. `<T, U>` */
	typeParams?: string
}

const LEADING_DECL_MODIFIER_RE =
	/^(public|protected|private|internal|open|abstract|sealed|override|static|mut|unsafe|foreign|operator)\s+/

function findNameIndexInDeclarationLine(line: string, name: string): number {
	if (!name) return -1
	try {
		const re = new RegExp(`\\b${name.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}\\b`)
		const m2 = line.match(re)
		return m2?.index ?? line.indexOf(name)
	} catch {
		return line.indexOf(name)
	}
}

function scanCangjieTextStateUpTo(s: string, endExclusive: number): {
	inString: boolean
	inChar: boolean
	inLineComment: boolean
	inBlock: number
} {
	let inString = false
	let inChar = false
	let inLineComment = false
	let inBlock = 0 // Counter for nested /* */
	let i = 0
	while (i < endExclusive && i < s.length) {
		const ch = s[i]
		const next = i + 1 < s.length ? s[i + 1] : ""

		if (inLineComment) {
			if (ch === "\n") inLineComment = false
			i++
			continue
		}
		if (inBlock > 0) {
			if (ch === "*" && next === "/") {
				inBlock--
				i += 2
				continue
			}
			i++
			continue
		}
		if (inString) {
			if (ch === "\\") {
				// Skip known escape sequences (\", \\, \n, \t, \r, \uXXXX).
				// Unknown escapes (\z etc.) are treated as literal backslash + char;
				// they won't cause index out of bounds due to the i+=2 guard.
				i += 2
				continue
			}
			if (ch === '"') inString = false
			i++
			continue
		}
		if (inChar) {
			if (ch === "\\") {
				i += 2
				continue
			}
			if (ch === "'") inChar = false
			i++
			continue
		}

		if (ch === "/" && next === "/") {
			inLineComment = true
			i += 2
			continue
		}
		if (ch === "/" && next === "*") {
			inBlock++
			i += 2
			continue
		}
		if (ch === '"') {
			inString = true
			i++
			continue
		}
		if (ch === "'") {
			inChar = true
			i++
			continue
		}
		i++
	}
	return { inString, inChar, inLineComment, inBlock }
}

/**
 * From `s[openIdx] === '<'`, find the matching `>` index (inclusive) with nesting,
 * ignoring `<`/`>` inside line comments, block comments, `"`, and `'`.
 * `openIdx` may be mid-string: if that `<` lies inside a string or comment, returns `-1`.
 */
export function findClosingAngleBracketIndex(s: string, openIdx: number): number {
	if (openIdx < 0 || openIdx >= s.length || s[openIdx] !== "<") return -1

	const prefix = scanCangjieTextStateUpTo(s, openIdx)
	if (prefix.inString || prefix.inChar || prefix.inLineComment || prefix.inBlock) return -1

	let depth = 0
	let i = openIdx
	let inString = false
	let inChar = false
	let inLineComment = false
	let inBlock = 0 // Counter for nested /* */ comments

	while (i < s.length) {
		const ch = s[i]
		const next = i + 1 < s.length ? s[i + 1] : ""

		if (inLineComment) {
			if (ch === "\n") inLineComment = false
			i++
			continue
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock--
				i += 2
				continue
			}
			i++
			continue
		}
		if (inString) {
			if (ch === "\\") {
				i += 2
				continue
			}
			if (ch === '"') inString = false
			i++
			continue
		}
		if (inChar) {
			if (ch === "\\") {
				i += 2
				continue
			}
			if (ch === "'") inChar = false
			i++
			continue
		}

		if (ch === "/" && next === "/") {
			inLineComment = true
			i += 2
			continue
		}
		if (ch === "/" && next === "*") {
			inBlock++
			i += 2
			continue
		}
		if (ch === '"') {
			inString = true
			i++
			continue
		}
		if (ch === "'") {
			inChar = true
			i++
			continue
		}

		if (ch === "<") {
			depth++
			i++
			continue
		}
		if (ch === ">") {
			depth--
			if (depth === 0) return i
			i++
			continue
		}
		i++
	}
	return -1
}

/**
 * Parse leading visibility / modifiers on the declaration start line, and `<...>` after `name`
 * using up to {@link SIGNATURE_SCAN_MAX_LINES_TYPE} lines (multi-line generic bounds; string/comment-safe).
 */
export function extractCangjieDeclarationMeta(
	lines: string[],
	startLine: number,
	name: string,
): CangjieDeclarationMeta {
	const line = lines[startLine] ?? ""
	const modifiers: string[] = []
	let visibility: CangjieSymbolVisibility = "internal"
	let s = line.replace(/^\s*/, "")
	for (;;) {
		const m = s.match(LEADING_DECL_MODIFIER_RE)
		if (!m) break
		const w = m[1]
		if (w === "public" || w === "protected" || w === "private" || w === "internal") {
			visibility = w
		} else {
			modifiers.push(w)
		}
		s = s.slice(m[0].length)
	}

	let typeParams: string | undefined
	const nameIdx = findNameIndexInDeclarationLine(line, name)
	if (nameIdx >= 0) {
		const lastLine = Math.min(startLine + SIGNATURE_SCAN_MAX_LINES_TYPE - 1, lines.length - 1)
		const buffer = lines.slice(startLine, lastLine + 1).join("\n")
		let pos = nameIdx + name.length
		while (pos < buffer.length && /\s/.test(buffer[pos])) pos++
		if (pos < buffer.length && buffer[pos] === "<") {
			const close = findClosingAngleBracketIndex(buffer, pos)
			if (close >= 0) typeParams = buffer.slice(pos, close + 1)
		}
	}

	return { visibility, modifiers, typeParams }
}

// ─── Regex-based heuristic parser ───

const MODIFIER_PREFIX = `(?:(?:public|protected|private|internal|open|abstract|sealed|override|static|mut|unsafe|foreign|operator)\\s+)*`

const DEF_PATTERNS: { kind: CangjieDefKind; re: RegExp }[] = [
	{ kind: "class", re: new RegExp(`^\\s*${MODIFIER_PREFIX}class\\s+(\\w+)`) },
	{ kind: "struct", re: new RegExp(`^\\s*${MODIFIER_PREFIX}struct\\s+(\\w+)`) },
	{ kind: "interface", re: new RegExp(`^\\s*${MODIFIER_PREFIX}interface\\s+(\\w+)`) },
	{ kind: "enum", re: new RegExp(`^\\s*${MODIFIER_PREFIX}enum\\s+(\\w+)`) },
	{ kind: "operator", re: new RegExp(`^\\s*${MODIFIER_PREFIX}operator\\s+func\\s+(\\S+)`) },
	{ kind: "func", re: new RegExp(`^\\s*${MODIFIER_PREFIX}func\\s+(\\w+)`) },
	{ kind: "macro", re: new RegExp(`^\\s*${MODIFIER_PREFIX}macro\\s+(\\w+)`) },
	{ kind: "init", re: new RegExp(`^\\s*${MODIFIER_PREFIX}init\\s*\\(`) },
	{ kind: "prop", re: new RegExp(`^\\s*${MODIFIER_PREFIX}prop\\s+(\\w+)`) },
	{ kind: "extend", re: new RegExp(`^\\s*${MODIFIER_PREFIX}extend\\s+(\\w[\\w<>, ]*?)(?:<:|extends|where|\\{)`) },
	{ kind: "type_alias", re: new RegExp(`^\\s*${MODIFIER_PREFIX}type\\s+(\\w+)\\s*=`) },
	{ kind: "var", re: new RegExp(`^\\s*${MODIFIER_PREFIX}var\\s+(\\w+)`) },
	{ kind: "let", re: new RegExp(`^\\s*${MODIFIER_PREFIX}let\\s+(\\w+)`) },
	{ kind: "main", re: /^\s*main\s*\(/ },
	{ kind: "package", re: /^\s*(?:macro\s+)?package\s+(\S+)/ },
	{ kind: "import", re: /^\s*(?:internal\s+)?import\s+(\S+)/ },
]

/**
 * Find the closing brace that matches the opening brace at `openLine`.
 * Returns the 0-based line index of the `}`, or `openLine` if none found.
 *
 * Skips braces inside string literals (`"…"`), character literals (`'…'`),
 * line comments (`//`), and block comments (`/* … * /`).
 */
export function findClosingBrace(lines: string[], openLine: number): number {
	let depth = 0
	let inBlockComment = false
	for (let i = openLine; i < lines.length; i++) {
		const line = lines[i]
		let inString = false
		let inChar = false
		let j = 0
		while (j < line.length) {
			const ch = line[j]
			const next = j + 1 < line.length ? line[j + 1] : ""

			if (inBlockComment) {
				if (ch === "*" && next === "/") { inBlockComment = false; j += 2; continue }
				j++; continue
			}
			if (inString) {
				if (ch === "\\" ) { j += 2; continue }
				if (ch === '"') inString = false
				j++; continue
			}
			if (inChar) {
				if (ch === "\\") { j += 2; continue }
				if (ch === "'") inChar = false
				j++; continue
			}
			if (ch === "/" && next === "/") break
			if (ch === "/" && next === "*") { inBlockComment = true; j += 2; continue }
			if (ch === '"') { inString = true; j++; continue }
			if (ch === "'") { inChar = true; j++; continue }

			if (ch === "{") depth++
			if (ch === "}") { depth--; if (depth === 0) return i }
			j++
		}
	}
	// No matching brace found -- return last line as best-effort boundary.
	// This prevents the entire file tail from collapsing into one span.
	logger.warn("CangjieParser",
		`findClosingBrace: unmatched { at line ${openLine}, treating file end as boundary`,
	)
	return Math.max(openLine, lines.length - 1)
}

/**
 * Determine whether a definition kind is a "block" definition (has `{ ... }`).
 */
function isBlockDef(kind: CangjieDefKind): boolean {
	return ["class", "struct", "interface", "enum", "func", "extend", "main", "macro", "init", "prop", "operator"].includes(kind)
}

function isEnumContainer(kind: CangjieDefKind): boolean {
	return kind === "enum"
}

/**
 * Strip trailing `//` comment from a line, respecting string and character
 * literal boundaries. Returns the code-only prefix.
 */
function stripInlineComment(line: string): string {
	let inString = false
	let inChar = false
	for (let i = 0; i < line.length - 1; i++) {
		const ch = line[i]
		if (inString) {
			if (ch === "\\") { i++; continue }
			if (ch === '"') { inString = false; continue }
			continue
		}
		if (inChar) {
			if (ch === "\\") { i++; continue }
			if (ch === "'") { inChar = false; continue }
			continue
		}
		if (ch === '"') { inString = true; continue }
		if (ch === "'") { inChar = true; continue }
		if (ch === "/" && line[i + 1] === "/") return line.slice(0, i)
	}
	return line
}

/**
 * Fast regex-based parser. Returns definitions found in the source.
 * Tracks multi-line block comment state so declarations inside `/* … *‍/`
 * are not falsely reported.
 */
export function parseCangjieDefinitions(content: string): CangjieDef[] {
	const lines = content.split("\n")
	const defs: CangjieDef[] = []
	const processedLines = new Set<number>()
	let inBlockComment = false

	for (let i = 0; i < lines.length; i++) {
		if (processedLines.has(i)) continue
		let line = lines[i]

		// Track multi-line block comments
		if (inBlockComment) {
			const endIdx = line.indexOf("*/")
			if (endIdx === -1) continue // still inside block comment, skip entire line
			line = line.slice(endIdx + 2) // resume after */
			inBlockComment = false
		}

		// Handle block comments on this line
		const blockStart = line.indexOf("/*")
		if (blockStart !== -1) {
			const blockEnd = line.indexOf("*/", blockStart + 2)
			if (blockEnd !== -1) {
				// Block comment starts and ends on same line: remove it
				line = line.slice(0, blockStart) + " " + line.slice(blockEnd + 2)
			} else {
				// Block comment starts here and continues to later lines
				line = line.slice(0, blockStart)
				inBlockComment = true
			}
		}

		// Strip trailing // comment from the remaining code portion

		// Backtrack up to 5 lines for annotations (@Attr) on multi-line declarations.
		let annotationLine = ""
		for (let back = i - 1; back >= Math.max(0, i - 5); back--) {
			const prev = lines[back].trim()
			if (prev.startsWith("@")) {
				annotationLine = prev + " " + annotationLine
			} else if (prev) {
				break
			}
		}
		const effectiveLine = annotationLine ? annotationLine + " " + line : line

		const trimmed = line.trim()
		if (!trimmed) continue

		for (const { kind, re } of DEF_PATTERNS) {
			let match = line.match(re)
			// If no match on current line, try with backtracked annotation prefix
			if (!match && annotationLine) {
				match = effectiveLine.match(re)
			}
			if (!match) continue

			const name = match[1] ?? kind
			let endLine = i

			if (isBlockDef(kind)) {
				if (line.includes("{")) {
					endLine = findClosingBrace(lines, i)
				} else {
					// Opening brace may be on the next line
					for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
						if (lines[j].includes("{")) {
							endLine = findClosingBrace(lines, j)
							break
						}
					}
				}
			}

			// Top-level var/let: single-line unless it contains a lambda
			if ((kind === "var" || kind === "let") && line.includes("{")) {
				endLine = findClosingBrace(lines, i)
			}

			defs.push({ kind, name, startLine: i, endLine })

			// Extract enum variants from the body
			if (kind === "enum" && endLine > i) {
				for (let el = i + 1; el <= endLine && el < lines.length; el++) {
					const elTrim = lines[el].trim()
					// Match enum variant: identifier (possibly with = value)
					const variantMatch = elTrim.match(/^(\w+)\s*(?:=|,|$)/)
					if (variantMatch && !["case", "public", "private", "protected"].includes(variantMatch[1])) {
						defs.push({ kind: "enum_case", name: variantMatch[1], startLine: el, endLine: el })
					}
				}
			}

			// Only mark the declaration line itself to allow nested types to be discovered
			processedLines.add(i)
			break // First matching pattern wins
		}
	}

	return defs
}

/** Max lines to scan for a multi-line signature ending at `{` (func / macro / main). */
export const SIGNATURE_SCAN_MAX_LINES_FUNC = 12
/** Max lines for class / struct / interface / enum / extend / type_alias headers. */
export const SIGNATURE_SCAN_MAX_LINES_TYPE = 8

/**
 * Find the first `{` in a line that is NOT inside a string or character literal.
 * Returns -1 when no such brace exists.
 */
function findFirstBraceOutsideString(line: string): number {
	let inString = false
	let inChar = false
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (inString) {
			if (ch === "\\") { i++; continue }
			if (ch === '"') { inString = false; continue }
			continue
		}
		if (inChar) {
			if (ch === "\\") { i++; continue }
			if (ch === "'") { inChar = false; continue }
			continue
		}
		if (ch === '"') { inString = true; continue }
		if (ch === "'") { inChar = true; continue }
		if (ch === "{" ) return i
	}
	return -1
}

/**
 * Build a display signature from source lines: for declarations that may span lines,
 * concatenate from startLine until the opening `{` of the body (exclusive), capped by maxLines.
 * Falls back to the first line only for import/package and simple top-level var/let.
 */
export function computeCangjieSignature(
	lines: string[],
	def: Pick<CangjieDef, "kind" | "startLine" | "endLine">,
): string {
	const first = lines[def.startLine]?.trim() ?? ""
	if (!first) return ""

	const multilineFuncKinds: CangjieDefKind[] = ["func", "macro", "main"]
	const multilineTypeKinds: CangjieDefKind[] = ["class", "struct", "interface", "enum", "extend", "type_alias"]

	let maxScan: number
	if (multilineFuncKinds.includes(def.kind)) {
		maxScan = SIGNATURE_SCAN_MAX_LINES_FUNC
	} else if (multilineTypeKinds.includes(def.kind)) {
		maxScan = SIGNATURE_SCAN_MAX_LINES_TYPE
	} else {
		return first
	}

	const lastLine = Math.min(def.startLine + maxScan - 1, lines.length - 1)
	const parts: string[] = []

	for (let i = def.startLine; i <= lastLine; i++) {
		const raw = lines[i]
		if (raw === undefined) break
		const braceIdx = findFirstBraceOutsideString(raw)
		if (braceIdx !== -1) {
			const before = raw.slice(0, braceIdx).trim()
			if (before.length > 0) {
				parts.push(before)
			}
			break
		}
		parts.push(raw.trim())
	}

	if (parts.length === 0) return first
	return parts.join(" ").replace(/\s+/g, " ").trim() || first
}

/** Lines inside class/struct/interface bodies that look like members (heuristic). */
const TYPE_MEMBER_LINE_RE =
	/^\s*(?:public|protected|private|internal|open|abstract|static|mut|override|redef|unsafe|sealed|\s)*(?:var|let|func|prop|init|operator\s+func)\s+/

/** Enum variants: `| Name` / `| Name(Type)` and case-style branches */
const ENUM_VARIANT_LINE_RE = /^\s*\|\s*.+/
const CASE_LINE_RE = /^\s*case\s+[\w(]/

type TypeMemberBucket = "methods" | "properties" | "operators" | "inits" | "enumCases"

export interface TypeMemberSummaryResult {
	/** Flat list (first `maxMembers` lines), for backward compatibility. */
	members: string[]
	methods: string[]
	properties: string[]
	operators: string[]
	inits: string[]
	enumCases: string[]
	totalMatchingLines: number
}

function classifyTypeMemberLine(trimmed: string): TypeMemberBucket | null {
	if (ENUM_VARIANT_LINE_RE.test(trimmed) || CASE_LINE_RE.test(trimmed)) return "enumCases"
	if (/operator\s+func\b/.test(trimmed)) return "operators"
	if (/\binit\s*\(/.test(trimmed)) return "inits"
	if (/\bprop\b/.test(trimmed) || /^\s*(?:public|protected|private|internal|open|static|mut|override|redef|unsafe|sealed|\s)*(?:var|let)\s+/.test(trimmed)) {
		return "properties"
	}
	if (/\bfunc\s+/.test(trimmed)) return "methods"
	return null
}

/**
 * Scan the body between the first `{` on/after `declStartLine` and `declEndLine`
 * for var/let/func/prop-like lines. Caps listed members at `maxMembers`.
 */
export function extractTypeMemberSummaries(
	lines: string[],
	declStartLine: number,
	declEndLine: number,
	maxMembers = 12,
): TypeMemberSummaryResult {
	const empty: TypeMemberSummaryResult = {
		members: [],
		methods: [],
		properties: [],
		operators: [],
		inits: [],
		enumCases: [],
		totalMatchingLines: 0,
	}

	let openLine = -1
	const maxSearch = Math.min(declStartLine + 25, lines.length - 1)
	for (let i = declStartLine; i <= maxSearch; i++) {
		if (lines[i] !== undefined && findFirstBraceOutsideString(lines[i]) !== -1) {
			openLine = i
			break
		}
	}
	if (openLine < 0) {
		return empty
	}

	const members: string[] = []
	const methods: string[] = []
	const properties: string[] = []
	const operators: string[] = []
	const inits: string[] = []
	const enumCases: string[] = []
	let totalMatchingLines = 0

	const pushBucket = (bucket: string[], line: string, cap: number) => {
		if (bucket.length < cap) bucket.push(line)
	}

	for (let i = openLine + 1; i <= declEndLine; i++) {
		const trimmed = lines[i]?.trim() ?? ""
		if (!trimmed || trimmed.startsWith("//")) continue
		const isMember =
			TYPE_MEMBER_LINE_RE.test(trimmed) ||
			ENUM_VARIANT_LINE_RE.test(trimmed) ||
			CASE_LINE_RE.test(trimmed)
		if (!isMember) continue

		totalMatchingLines++
		const normalized = trimmed.replace(/\s+/g, " ")
		if (members.length < maxMembers) {
			members.push(normalized)
		}

		const kind = classifyTypeMemberLine(trimmed)
		const cap = Math.max(4, Math.floor(maxMembers / 2))
		if (kind === "methods") pushBucket(methods, normalized, cap)
		else if (kind === "properties") pushBucket(properties, normalized, cap)
		else if (kind === "operators") pushBucket(operators, normalized, cap)
		else if (kind === "inits") pushBucket(inits, normalized, cap)
		else if (kind === "enumCases") pushBucket(enumCases, normalized, cap)
	}

	return {
		members,
		methods,
		properties,
		operators,
		inits,
		enumCases,
		totalMatchingLines,
	}
}

/**
 * Convert extracted definitions into mock QueryCaptures compatible with
 * processCaptures() in tree-sitter/index.ts.
 */
export function cangjieDefsToCaptures(defs: CangjieDef[], lines: string[]): QueryCapture[] {
	const captures: MockCapture[] = []

	for (const def of defs) {
		// Skip imports / package headers — they are single-line and not structural
		if (def.kind === "import" || def.kind === "package") continue

		const node: MockNode = {
			startPosition: { row: def.startLine },
			endPosition: { row: def.endLine },
			text: def.name,
		}

		captures.push({
			node,
			name: `name.definition.${def.kind}`,
			patternIndex: 0,
		})

		captures.push({
			node,
			name: `definition.${def.kind}`,
			patternIndex: 0,
		})
	}

	return captures as QueryCapture[]
}

/**
 * High-level entry: parse a Cangjie source string and return mock captures.
 */
export function parseCangjie(content: string): QueryCapture[] {
	if (!content || content.trim() === "") return []
	const defs = parseCangjieDefinitions(content)
	return cangjieDefsToCaptures(defs, content.split("\n"))
}

// ─── cjc --dump-ast integration (optional, best-effort) ───

interface CjcAstNode {
	type: string
	name?: string
	startLine?: number
	endLine?: number
	children: CjcAstNode[]
}

/**
 * Resolve the `cjc` executable path from configuration or environment.
 */
function resolveCjcPath(): string | undefined {
	const configured = vscode.workspace
		.getConfiguration(Package.name)
		.get<string>("cangjieLsp.cjcPath", "")

	if (configured) {
		const resolved = path.resolve(configured)
		if (fs.existsSync(resolved)) return resolved
		return undefined
	}

	const cangjieHome = process.env.CANGJIE_HOME
	if (cangjieHome) {
		const candidates = [
			path.join(cangjieHome, "bin", "cjc.exe"),
			path.join(cangjieHome, "bin", "cjc"),
		]
		for (const c of candidates) {
			if (fs.existsSync(c)) return c
		}
	}

	return process.platform === "win32" ? "cjc.exe" : "cjc"
}

/**
 * Parse the tree-structured text output of `cjc --dump-ast --dump-to-screen`.
 *
 * Example fragment:
 * ```
 * ClassDecl {
 *   -identifier: Token {
 *     value: "Data"
 *     kind: IDENTIFIER
 *     pos: 1: 7
 *   }
 *   ...
 * }
 * ```
 */
function parseCjcDumpOutput(output: string): CjcAstNode[] {
	const nodes: CjcAstNode[] = []
	const lines = output.split("\n")

	const nodeStartRe = /^(\s*)(?:-?\w+:\s*)?(\w+)\s*\{/
	const identifierValueRe = /^\s*value:\s*"(.+)"/
	const posRe = /^\s*pos:\s*(\d+):\s*(\d+)/

	interface ParseCtx {
		type: string
		indent: number
		name?: string
		startLine?: number
	}

	const stack: ParseCtx[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]

		const startMatch = line.match(nodeStartRe)
		if (startMatch) {
			const indent = startMatch[1].length
			const nodeType = startMatch[2]
			stack.push({ type: nodeType, indent })
			continue
		}

		if (stack.length > 0) {
			const current = stack[stack.length - 1]

			const idMatch = line.match(identifierValueRe)
			if (idMatch && !current.name) {
				current.name = idMatch[1]
			}

			const posMatch = line.match(posRe)
			if (posMatch && current.startLine === undefined) {
				current.startLine = parseInt(posMatch[1]) - 1 // Convert to 0-based
			}
		}

		if (line.trim() === "}") {
			const finished = stack.pop()
			if (finished) {
				const declTypes = [
					"ClassDecl", "StructDecl", "InterfaceDecl", "EnumDecl",
					"FuncDecl", "MacroDecl", "VarDecl", "MainDecl",
					"ExtendDecl", "TypeAliasDecl",
				]
				if (declTypes.includes(finished.type)) {
					nodes.push({
						type: finished.type,
						name: finished.name,
						startLine: finished.startLine,
						children: [],
					})
				}
			}
		}
	}

	return nodes
}

function cjcNodeKindToDefKind(nodeType: string): CangjieDefKind {
	const map: Record<string, CangjieDefKind> = {
		ClassDecl: "class",
		StructDecl: "struct",
		InterfaceDecl: "interface",
		EnumDecl: "enum",
		FuncDecl: "func",
		MacroDecl: "macro",
		VarDecl: "var",
		MainDecl: "main",
		ExtendDecl: "extend",
		TypeAliasDecl: "type_alias",
	}
	return map[nodeType] ?? "func"
}

/**
 * Run `cjc --dump-ast --dump-to-screen` on a file and convert the output
 * to CangjieDef[]. Returns undefined if cjc is not available or fails.
 */
export async function parseCangjieCjcAst(filePath: string): Promise<CangjieDef[] | undefined> {
	const cjcPath = resolveCjcPath()
	if (!cjcPath) return undefined

	try {
		const { stdout } = await execFileAsync(
			cjcPath,
			["--dump-ast", "--dump-to-screen", filePath],
			{ timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
		)

		const astNodes = parseCjcDumpOutput(stdout)
		if (astNodes.length === 0) return undefined

		// Read the source file to compute end-lines via brace matching
		const content = fs.readFileSync(filePath, "utf-8")
		const sourceLines = content.split("\n")

		return astNodes.map((node) => {
			const startLine = node.startLine ?? 0
			let endLine = startLine

			if (["ClassDecl", "StructDecl", "InterfaceDecl", "EnumDecl", "FuncDecl", "MacroDecl", "ExtendDecl", "MainDecl"].includes(node.type)) {
				// Find the closing brace from source
				for (let j = startLine; j < Math.min(startLine + 3, sourceLines.length); j++) {
					if (sourceLines[j].includes("{")) {
						endLine = findClosingBrace(sourceLines, j)
						break
					}
				}
			}

			return {
				kind: cjcNodeKindToDefKind(node.type),
				name: node.name ?? node.type,
				startLine,
				endLine,
			}
		})
	} catch {
		return undefined
	}
}

/**
 * Try cjc AST first, fall back to regex parser.
 * Used for code-index integration where richer structure is beneficial.
 */
export async function parseCangjieWithFallback(
	filePath: string,
	content: string,
): Promise<CangjieDef[]> {
	const cjcDefs = await parseCangjieCjcAst(filePath)
	if (cjcDefs && cjcDefs.length > 0) return cjcDefs
	return parseCangjieDefinitions(content)
}
