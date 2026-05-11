import { describe, it, expect } from "vitest"
import { getErrorMessage } from "../error-utils"

describe("getErrorMessage semantics", () => {
	it("returns message for Error instances", () => {
		expect(getErrorMessage(new Error("test"))).toBe("test")
	})

	it("returns string values as-is", () => {
		expect(getErrorMessage("plain string")).toBe("plain string")
	})

	it("returns String() for other types", () => {
		expect(getErrorMessage(42)).toBe("42")
		expect(getErrorMessage(null)).toBe("null")
		expect(getErrorMessage(undefined)).toBe("undefined")
		expect(getErrorMessage({})).toBe("[object Object]")
	})

	it("matches inline pattern for all common error types", () => {
		const inlinePattern = (e: unknown) => (e instanceof Error ? e.message : String(e))
		const cases: unknown[] = [new Error("err"), "str", 42, null, undefined, {}, [1, 2]]
		for (const c of cases) {
			expect(getErrorMessage(c)).toBe(inlinePattern(c))
		}
	})
})
