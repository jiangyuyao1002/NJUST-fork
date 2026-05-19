import { getErrorMessage } from "../shared/error-utils"
/**
 * Safe regex construction with ReDoS protection.
 *
 * Validates user/LLM-supplied regex patterns before constructing
 * JavaScript RegExp objects. Prevents catastrophic backtracking
 * that could hang the Node.js event loop.
 */

/** Maximum allowed pattern length to prevent resource exhaustion */
const MAX_PATTERN_LENGTH = 1000

/**
 * Maximum allowed group nesting depth (groups that are themselves quantified).
 * 2 allows safe patterns like (foo)+ but rejects ((a+)+)+.
 */
const MAX_QUANTIFIER_DEPTH = 2

/**
 * Patterns known to cause exponential backtracking in JS regex engines.
 * Covers greedy, lazy, possessive variants and bounded quantifiers.
 */
const REDOS_PATTERNS = [
	/\([^)]*[+*][^)]*\)[+*]/,
	/\([^)]*[+*]\?[^)]*\)[+*]\??/,
	/\([^)]*\{[^}]+\}[^)]*\)[+*]/,
	/\([^)]*\|[^)]*\)[+*]\s*[+*]/,
	/\([^)]*\|[^)]*\)[+*]\??\s*[+*]/,
	/\(\[[^\]]*\][+*]\)[+*]/,
	/\(\[[^\]]*\]\{[^}]+\}\)[+*]/,
	/\(\([^)]*[+*][^)]*\)[+*]\)[+*]/,
]

function quantifierNestingDepth(pattern: string): number {
	let depth = 0
	let maxDepth = 0
	let i = 0

	while (i < pattern.length) {
		const ch = pattern[i]!

		if (ch === "\\" && i + 1 < pattern.length) {
			i += 2
			continue
		}

		if (ch === "(") {
			const next = pattern[i + 1]
			if (next === "?" && i + 2 < pattern.length) {
				const afterQ = pattern[i + 2]!
				if (afterQ === ":" || afterQ === "=" || afterQ === "!" || afterQ === "<") {
					depth++
					if (depth > maxDepth) maxDepth = depth
					i++
					continue
				}
			} else if (next !== "?") {
				depth++
				if (depth > maxDepth) maxDepth = depth
				i++
				continue
			}
		}

		if (ch === ")" && depth > 0) {
			depth--
			const rest = pattern.slice(i + 1)
			const quantifierMatch = rest.match(/^[+*]\??|\{[^}]+\}/)
			if (quantifierMatch) {
				const effective = depth + 1
				if (effective > maxDepth) maxDepth = effective
			}
			i++
			continue
		}

		if (ch === "]") {
			const rest = pattern.slice(i + 1)
			const quantifierMatch = rest.match(/^[+*]\??|\{[^}]+\}/)
			if (quantifierMatch) {
				const effective = depth + 1
				if (effective > maxDepth) maxDepth = effective
			}
			i++
			continue
		}

		i++
	}

	return maxDepth
}

/**
 * Validate a regex pattern string for safety before constructing a RegExp.
 * Returns { valid: true } if safe, or { valid: false, reason } if not.
 */
export function validateRegexPattern(pattern: string): { valid: true } | { valid: false; reason: string } {
	if (!pattern || pattern.length === 0) {
		return { valid: false, reason: "Empty pattern" }
	}

	if (pattern.length > MAX_PATTERN_LENGTH) {
		return {
			valid: false,
			reason: `Pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH} characters)`,
		}
	}

	for (const redosPattern of REDOS_PATTERNS) {
		if (redosPattern.test(pattern)) {
			return {
				valid: false,
				reason: "Pattern contains nested quantifiers that may cause ReDoS",
			}
		}
	}

	const nestingDepth = quantifierNestingDepth(pattern)
	if (nestingDepth > MAX_QUANTIFIER_DEPTH) {
		return {
			valid: false,
			reason: `Pattern quantifier nesting depth (${nestingDepth}) exceeds limit (${MAX_QUANTIFIER_DEPTH})`,
		}
	}

	try {
		new RegExp(pattern)
	} catch (e) {
		return {
			valid: false,
			reason: `Invalid regex syntax: ${getErrorMessage(e)}`,
		}
	}

	return { valid: true }
}
