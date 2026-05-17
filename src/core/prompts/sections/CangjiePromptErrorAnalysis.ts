import * as fs from "fs"
import * as path from "path"

import {
	getErrorFixDirective as getAnalyzerErrorFixDirective,
	getMatchingCjcPatternsByCategory,
} from "../../../services/cangjie-lsp/CangjieErrorAnalyzer"
import { CangjieSymbolIndex } from "../../../services/cangjie-lsp/CangjieSymbolIndex"

import { resolveCangjieDocsBasePath } from "./CangjieDocsResolver"
import { extractImports } from "./CangjieImportParser"

const ERROR_CONTEXT_RADIUS = 15
const ERROR_CONTEXT_MAX_LOCATIONS = 8
const EXEC_CMD_ERROR_MAX_PATTERNS_PER_BLOCK = 5

function formatSingleErrorLocationBlockSync(cwd: string, filePart: string, lineStr: string): string | null {
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
			.map((line, index) => {
				const num = start + index + 1
				const marker = num === lineNum + 1 ? " >>>" : "    "
				return `${marker} ${num}: ${line}`
			})
			.join("\n")

		const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
		let block = `文件: ${relPath} (第 ${lineNum + 1} 行)\n${snippet}`

		if (filePath.endsWith(".cj")) {
			const fileImports = extractImports(content)
			if (fileImports.length > 0) {
				block += `\n  文件 import: ${fileImports.slice(0, 12).join(", ")}${fileImports.length > 12 ? " ..." : ""}`
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
		const lineNum = parseInt(lineStr!, 10) - 1
		const filePath = path.isAbsolute(filePart!) ? filePart! : path.resolve(cwd, filePart!)
		const key = `${filePath}:${lineNum}`
		if (seen.has(key)) continue
		seen.add(key)

		const block = formatSingleErrorLocationBlockSync(cwd, filePart!, lineStr!)
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

/**
 * Single appendix for execute_command on cjpm/cjc failure: per-location blocks when present,
 * otherwise the compact generic error hint block.
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

		const firstNonEmpty = block.map((line) => line.trim()).find(Boolean) ?? ""
		const locMatch = firstNonEmpty.match(/^==>\s+(.+?):(\d+):(\d+):/)
		const header = locMatch ? `[${locMatch[1]} 第 ${locMatch[2]} 行 col ${locMatch[3]}]` : "[输出片段]"

		const snippet = locMatch != null ? formatSingleErrorLocationBlockSync(cwd, locMatch[1]!, locMatch[2]!) : null

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
			patternBlock = `（未匹配已知错误模式）\n-> 启发式建议: ${getAnalyzerErrorFixDirective(text)}`
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

	const repairPriority =
		"\n\n**修复优先级建议**: " +
		"1. import/符号错误（级联根因，修复后其他错误可能消失） -> " +
		"2. 类型不匹配/泛型约束 -> " +
		"3. mut/let 限制 -> " +
		"4. 语法/格式错误"

	const errorCount = blocks.length
	const failureHint =
		errorCount > 5
			? `\n\n检测到 ${errorCount} 处错误。建议集中修复最可能是根因的 import/符号问题，而非逐个修复所有错误。修复根因后重新编译，观察剩余错误是否减少。`
			: ""

	return `\n\n<cangjie_error_hints>\n按错误位置就近整理（每段含编译原文、源码上下文与建议）:\n\n${sections.join("\n\n---\n\n")}${repairPriority}${failureHint}\n</cangjie_error_hints>`
}

export const getErrorFixDirective = getAnalyzerErrorFixDirective
