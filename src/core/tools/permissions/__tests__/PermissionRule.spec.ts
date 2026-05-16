import { describe, expect, it } from "vitest"

import { DESTRUCTIVE_ALWAYS_ASK, READ_ONLY_AUTO_ALLOW, SOURCE_PRIORITY } from "../PermissionRule"

describe("PermissionRule presets", () => {
	it("orders permission sources from policy to session", () => {
		expect(SOURCE_PRIORITY.policy).toBeGreaterThan(SOURCE_PRIORITY.policySettings)
		expect(SOURCE_PRIORITY.policySettings).toBeGreaterThan(SOURCE_PRIORITY.project)
		expect(SOURCE_PRIORITY.project).toBeGreaterThan(SOURCE_PRIORITY.user)
		expect(SOURCE_PRIORITY.user).toBeGreaterThan(SOURCE_PRIORITY.session)
	})

	it("defines read-only auto allow as a placeholder rule", () => {
		expect(READ_ONLY_AUTO_ALLOW).toMatchObject({
			id: "built-in:read-only-auto-allow",
			action: "allow",
			toolPattern: "*",
			priority: 0,
		})
		expect(READ_ONLY_AUTO_ALLOW.condition?.("read_file", {})).toBe(false)
	})

	it("defines destructive always ask as a placeholder rule", () => {
		expect(DESTRUCTIVE_ALWAYS_ASK).toMatchObject({
			id: "built-in:destructive-always-ask",
			action: "ask",
			toolPattern: "*",
			priority: 10,
		})
		expect(DESTRUCTIVE_ALWAYS_ASK.condition?.("write_to_file", {})).toBe(false)
	})
})
