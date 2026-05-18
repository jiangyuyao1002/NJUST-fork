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
})
