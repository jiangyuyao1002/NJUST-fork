/**
 * Shared edit matching utilities extracted from EditFileTool.
 * Used by both EditTool (canonical) and EditFileTool (backward compat).
 */

export type LineEnding = "\r\n" | "\n"

export function countOccurrences(str: string, substr: string): number {
	if (substr === "") return 0
	let count = 0
	let pos = str.indexOf(substr)
	while (pos !== -1) {
		count++
		pos = str.indexOf(substr, pos + substr.length)
	}
	return count
}

export function safeLiteralReplace(str: string, oldString: string, newString: string): string {
	if (oldString === "" || !str.includes(oldString)) {
		return str
	}
	if (!newString.includes("$")) {
		return str.replaceAll(oldString, newString)
	}
	const escapedNewString = newString.replaceAll("$", "$$$$")
	return str.replaceAll(oldString, escapedNewString)
}

export function detectLineEnding(content: string): LineEnding {
	return content.includes("\r\n") ? "\r\n" : "\n"
}

export function normalizeToLF(content: string): string {
	return content.replace(/\r\n/g, "\n")
}

export function restoreLineEnding(contentLF: string, eol: LineEnding): string {
	if (eol === "\n") return contentLF
	return contentLF.replace(/\n/g, "\r\n")
}

export function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Multi-character operators/tokens: do not allow \\s+ to appear between these characters. */
const CANGJIE_COMPOSITE_OPS_SORTED = [
	"|>",
	"::",
	"<:",
	":>",
	"=>",
	"->",
	"<<",
	">>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"++",
	"--",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"&=",
	"|=",
	"^=",
	"..",
	"??",
].sort((a, b) => b.length - a.length)

function tokenizeCangjieForEditMatch(s: string): string[] {
	const out: string[] = []
	let i = 0
	while (i < s.length) {
		const c = s[i]
		if (/\s/.test(c!)) {
			let j = i
			while (j < s.length && /\s/.test(s[j]!)) j++
			out.push(s.slice(i, j))
			i = j
			continue
		}
		let matched = false
		for (const op of CANGJIE_COMPOSITE_OPS_SORTED) {
			if (s.startsWith(op, i)) {
				out.push(op)
				i += op.length
				matched = true
				break
			}
		}
		if (matched) continue
		out.push(c!)
		i++
	}
	return out
}

const MAX_WS_TOLERANT_PATTERN_LEN = 200

export function buildWhitespaceTolerantRegex(oldLF: string, opts?: { cangjie?: boolean }): RegExp {
	if (oldLF.length > MAX_WS_TOLERANT_PATTERN_LEN) {
		throw new Error(
			`Pattern too long for whitespace-tolerant regex: ${oldLF.length} > ${MAX_WS_TOLERANT_PATTERN_LEN}. ` +
				`ReDoS risk — split into smaller search blocks.`,
		)
	}
	if (oldLF === "") {
		return new RegExp("(?!)", "g")
	}
	const parts = opts?.cangjie ? tokenizeCangjieForEditMatch(oldLF) : (oldLF.match(/(\s+|\S+)/g) ?? [])
	const whitespacePatternForRun = (run: string): string => {
		if (run.includes("\n")) {
			return "\\s{1,6}" // Bounded quantifier to prevent ReDoS
		}
		return "[\\t ]{1,6}" // Bounded quantifier to prevent ReDoS
	}
	const pattern = parts
		.map((part) => {
			if (/^\s+$/.test(part)) {
				return whitespacePatternForRun(part)
			}
			return escapeRegExp(part)
		})
		.join("")
	return new RegExp(pattern, "g")
}

export function buildTokenRegex(oldLF: string): RegExp {
	const tokens = oldLF.split(/\s+/).filter(Boolean)
	if (tokens.length === 0) {
		return new RegExp("(?!)", "g")
	}
	const pattern = tokens.map(escapeRegExp).join("\\s+")
	return new RegExp(pattern, "g")
}

export function countRegexMatches(content: string, regex: RegExp): number {
	const stable = new RegExp(regex.source, regex.flags)
	return Array.from(content.matchAll(stable)).length
}
