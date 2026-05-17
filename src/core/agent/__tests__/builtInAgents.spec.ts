import { describe, expect, it } from "vitest"

import { BUILT_IN_AGENTS } from "../builtInAgents"

describe("BUILT_IN_AGENTS", () => {
	it("requires an explicit warning for bypass permission agents", () => {
		const bypassAgents = BUILT_IN_AGENTS.filter((agent) => agent.permissionMode === "bypassPermissions")

		expect(bypassAgents.length).toBeGreaterThan(0)
		for (const agent of bypassAgents) {
			expect(agent.permissionWarning).toMatch(/bypass/i)
			expect(agent.permissionWarning).toMatch(/read-only/i)
		}
	})

	it("does not add bypass warnings to normal permission agents", () => {
		const normalAgents = BUILT_IN_AGENTS.filter((agent) => agent.permissionMode !== "bypassPermissions")

		expect(normalAgents.length).toBeGreaterThan(0)
		for (const agent of normalAgents) {
			expect(agent.permissionWarning).toBeUndefined()
		}
	})
})
