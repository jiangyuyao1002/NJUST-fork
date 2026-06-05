import { describe, expect, it } from "vitest"
import { matchPatternRules } from "../patternRules.js"

describe("patternRules", () => {
	it("matches prefix rules", () => {
		expect(matchPatternRules("git status", [{ pattern: "git", effect: "allow" }])).toBe("allow")
	})

	it("matches regex rules", () => {
		expect(matchPatternRules("rm -rf /tmp/a", [{ pattern: "rm\\s+-rf", effect: "deny", type: "regex" }])).toBe(
			"deny",
		)
	})

	it("unsafe deny regex fails closed (returns deny)", () => {
		// A deny rule with a nested-quantifier pattern must NOT be silently skipped.
		// Fail-closed: treat as matching to conservatively block the command.
		const rules = [
			{ type: "regex" as const, pattern: "^(rm|del)+$", effect: "deny" as const },
			{ type: "prefix" as const, pattern: "", effect: "allow" as const },
		]
		// The pattern triggers OVERLAPPING_ALTERNATION_RE — it's flagged unsafe.
		// Fail-closed: deny rule → return "deny"
		expect(matchPatternRules("rmdel", rules)).toBe("deny")
		expect(matchPatternRules("rm", rules)).toBe("deny")
		// Even non-matching commands are denied (fail-closed on the unsafe pattern)
		expect(matchPatternRules("git status", rules)).toBe("deny")
	})

	it("unsafe allow regex is skipped", () => {
		// An allow rule with an unsafe regex must NOT auto-approve.
		const rules = [{ type: "regex" as const, pattern: "(a+)+$", effect: "allow" as const }]
		expect(matchPatternRules("aaaaaaaaaa", rules)).toBe("none")
	})

	it("overlong regex patterns are skipped", () => {
		const longPattern = "a".repeat(201)
		const rules = [{ type: "regex" as const, pattern: longPattern, effect: "deny" as const }]
		// Overlong deny pattern → isSafeRegex returns false → fail-closed: deny
		expect(matchPatternRules("aaa", rules)).toBe("deny")
	})

	it("commands exceeding max length skip regex but not prefix rules", () => {
		const longCommand = "a".repeat(501)
		const regexRules = [{ type: "regex" as const, pattern: "^a+$", effect: "deny" as const }]
		expect(matchPatternRules(longCommand, regexRules)).toBe("none")

		const prefixRules = [{ type: "prefix" as const, pattern: "a", effect: "deny" as const }]
		expect(matchPatternRules(longCommand, prefixRules)).toBe("deny")
	})

	it("invalid regex does not crash", () => {
		const rules = [{ type: "regex" as const, pattern: "[invalid", effect: "deny" as const }]
		expect(matchPatternRules("test", rules)).toBe("none")
	})

	it("safe deny regex executes normally", () => {
		// A deny rule with a safe regex should work as expected
		const rules = [{ type: "regex" as const, pattern: "^rm\\s+-rf", effect: "deny" as const }]
		expect(matchPatternRules("rm -rf /", rules)).toBe("deny")
		expect(matchPatternRules("git status", rules)).toBe("none")
	})
})
