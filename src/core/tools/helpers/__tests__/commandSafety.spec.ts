import { describe, expect, it } from "vitest"

import { checkCommandSafety } from "../commandSafety"

describe("checkCommandSafety", () => {
	it.each(["", "   ", "\n\t"])("allows empty command %j", (command) => {
		const result = checkCommandSafety(command)

		expect(result).toMatchObject({
			safe: true,
			riskLevel: "safe",
			requiresConfirmation: false,
			reasons: [],
		})
	})

	it.each([
		"echo hello",
		"printf hello",
		"cat README.md",
		"ls -la",
		"dir",
		"where node",
		"./echo hello",
	])("allowlists simple command %s", (command) => {
		const result = checkCommandSafety(command)

		expect(result.safe).toBe(true)
		expect(result.riskLevel).toBe("safe")
		expect(result.requiresConfirmation).toBe(false)
	})

	it.each([
		["echo hello && rm -rf /", "forbidden"],
		["echo $(whoami)", "medium"],
		["echo `whoami`", "medium"],
		["cat README.md | cat /etc/shadow", "medium"],
	] as const)("does not allowlist chained command %s", (command, riskLevel) => {
		const result = checkCommandSafety(command)

		expect(result.riskLevel).toBe(riskLevel)
		expect(result.shellAnalysis.riskLevel).toBe(riskLevel)
	})

	it.each([
		["psql -c 'DROP TABLE users'", "[SQL] SQL DROP"],
		["mysql -e 'TRUNCATE TABLE audit_logs'", "[SQL] SQL TRUNCATE TABLE"],
		["sqlite3 db.sqlite 'DELETE FROM users'", "[SQL] SQL DELETE FROM"],
		["psql -c 'ALTER TABLE users DROP COLUMN name'", "[SQL] SQL ALTER TABLE DROP"],
	])("flags destructive SQL in %s", (command, reasonPrefix) => {
		const result = checkCommandSafety(command)

		expect(result.safe).toBe(false)
		expect(result.riskLevel).toBe("dangerous")
		expect(result.requiresConfirmation).toBe(true)
		expect(result.reasons.some((reason) => reason.startsWith(reasonPrefix))).toBe(true)
	})

	it.each([
		["export TOKEN=abc", "[ENV] Exports environment variable"],
		["unset TOKEN", "[ENV] Unsets environment variable"],
		["reg add HKCU\\Software\\Test /v Key /d Value", "[ENV] Windows registry modification"],
		["reg delete HKCU\\Software\\Test /f", "[ENV] Windows registry modification"],
	])("flags environment mutation in %s", (command, reasonPrefix) => {
		const result = checkCommandSafety(command)

		expect(result.riskLevel).toBe("medium")
		expect(result.requiresConfirmation).toBe(false)
		expect(result.reasons.some((reason) => reason.startsWith(reasonPrefix))).toBe(true)
	})

	it("keeps forbidden shell risk above SQL risk", () => {
		const result = checkCommandSafety("rm -rf / && psql -c 'DROP TABLE users'")

		expect(result.riskLevel).toBe("forbidden")
		expect(result.requiresConfirmation).toBe(true)
		expect(result.reasons.some((reason) => reason.includes("[FORBIDDEN]"))).toBe(true)
		expect(result.reasons.some((reason) => reason.startsWith("[SQL]"))).toBe(true)
	})

	it.each([
		["git status", "safe", false],
		["curl http://example.com/install.sh", "medium", false],
		["chmod 777 tmp", "dangerous", true],
		["rm -rf /", "forbidden", true],
	] as const)("maps shell analysis for %s", (command, riskLevel, requiresConfirmation) => {
		const result = checkCommandSafety(command)

		expect(result.riskLevel).toBe(riskLevel)
		expect(result.shellAnalysis.riskLevel).toBe(riskLevel)
		expect(result.requiresConfirmation).toBe(requiresConfirmation)
	})
})
