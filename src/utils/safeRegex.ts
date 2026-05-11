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
 * Patterns known to cause exponential backtracking in JS regex engines.
 * These are conservative checks that reject the most common ReDoS vectors.
 */
const REDOS_PATTERNS = [
	// Nested quantifiers: (a+)+, (a*)*, (a+)*, etc.
	/\([^)]*[+*][^)]*\)[+*]/,
	// Alternation with quantifier: (a|b)+ repeated
	/\([^)]*\|[^)]*\)[+*]\s*[+*]/,
	// Overlapping character classes with quantifiers: ([a-z]+)+
	/\(\[[^\]]*\][+*]\)[+*]/,
]

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

	// Check for nested quantifier patterns that cause exponential backtracking
	for (const redosPattern of REDOS_PATTERNS) {
		if (redosPattern.test(pattern)) {
			return {
				valid: false,
				reason: "Pattern contains nested quantifiers that may cause ReDoS",
			}
		}
	}

	// Validate that the pattern is syntactically valid
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
