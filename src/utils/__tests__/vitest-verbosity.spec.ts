import { describe, expect, it } from "vitest"

import { resolveVerbosity } from "../vitest-verbosity"

describe("resolveVerbosity", () => {
	it("uses silent mode without a console hook by default", () => {
		expect(resolveVerbosity([])).toEqual({
			silent: true,
			reporters: ["dot"],
		})
	})

	it("shows console output when silent mode is disabled", () => {
		expect(resolveVerbosity(["--no-silent"])).toEqual({
			silent: false,
			reporters: ["dot"],
		})
	})

	it("adds the verbose reporter when requested", () => {
		expect(resolveVerbosity(["--reporter=verbose"])).toEqual({
			silent: true,
			reporters: ["dot", "verbose"],
		})
	})
})
