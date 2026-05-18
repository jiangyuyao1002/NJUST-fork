export type PatternRule = {
	pattern: string
	effect: "allow" | "deny"
	type?: "prefix" | "regex"
}

export type PatternRuleMatch = "allow" | "deny" | "none"

export function matchPatternRules(command: string, rules: PatternRule[]): PatternRuleMatch {
	for (const r of rules) {
		if ((r.type ?? "prefix") === "regex") {
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
