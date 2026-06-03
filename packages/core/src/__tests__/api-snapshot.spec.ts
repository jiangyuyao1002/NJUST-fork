/**
 * API Snapshot Test — Ensures packages/core public API remains stable.
 * Any change to the exported names requires updating the snapshot.
 */
import { describe, it, expect } from "vitest"
import * as core from "../index.js"

describe("packages/core public API snapshot", () => {
	it("exports match expected surface", () => {
		const exportedNames = Object.keys(core).sort()
		expect(exportedNames).toMatchSnapshot()
	})

	it("namespace exports contain expected members", () => {
		// AutoApproval namespace
		expect(Object.keys(core.AutoApproval).sort()).toMatchSnapshot("AutoApproval members")

		// Shared namespace
		expect(Object.keys(core.Shared).sort()).toMatchSnapshot("Shared members")
	})

	it("all exports are defined (not undefined)", () => {
		for (const [key, value] of Object.entries(core)) {
			expect(value, `export "${key}" should not be undefined`).toBeDefined()
		}
	})
})
