export type PatternRule = {
	pattern: string
	effect: "allow" | "deny"
	type?: "prefix" | "regex"
}

export type PatternRuleMatch = "allow" | "deny" | "none"

/**
 * Maximum allowed length for user-defined regex patterns.
 * Longer patterns are increasingly likely to be malicious or accidental ReDoS vectors.
 */
const MAX_PATTERN_LENGTH = 200

/**
 * Maximum command length tested against regex patterns.
 * Longer commands amplify backtracking for pathological regex.
 * Commands beyond this limit are only tested against prefix rules.
 */
const MAX_COMMAND_LENGTH = 500

/**
 * Detects nested quantifier patterns that cause catastrophic backtracking (ReDoS).
 * Matches constructs like (a+)+, (a*)+, (a{1,100})+, (a?)+, etc.
 * Also detects overlapping-alternation with quantifiers like (a|aa)+$.
 * This is a conservative heuristic — it may reject some safe patterns.
 */
const NESTED_QUANTIFIER_RE = /\([^)]*[+*{?][^)]*\)[+*{]/
const OVERLAPPING_ALTERNATION_RE = /\([^)]*\|[^)]*\)[+*{]/

function isSafeRegex(pattern: string): boolean {
	if (pattern.length > MAX_PATTERN_LENGTH) return false
	if (NESTED_QUANTIFIER_RE.test(pattern)) return false
	if (OVERLAPPING_ALTERNATION_RE.test(pattern)) return false
	return true
}

export function matchPatternRules(command: string, rules: PatternRule[]): PatternRuleMatch {
	for (const r of rules) {
		if ((r.type ?? "prefix") === "regex") {
			if (!isSafeRegex(r.pattern)) {
				// Unsafe regex: fail-closed semantics.
				// - deny rules → treat as matching (block the command conservatively).
				// - allow rules → skip (don't auto-approve with an unsafe pattern).
				// The user should rewrite the pattern to avoid nested quantifiers.
				if (r.effect === "deny") return "deny"
				continue
			}
			// Skip regex evaluation for very long commands to limit backtracking cost.
			if (command.length > MAX_COMMAND_LENGTH) continue
			try {
				if (new RegExp(r.pattern, "i").test(command)) return r.effect
			} catch {
				// ignore bad regex
			}
		} else if (command.toLowerCase().startsWith(r.pattern.toLowerCase())) {
			return r.effect
		}
	}
	return "none"
}
