// npx vitest run src/core/task/__tests__/globalApiTiming.spec.ts

import { describe, it, expect, beforeEach } from "vitest"
import { getLastGlobalApiRequestTime, setLastGlobalApiRequestTime } from "../globalApiTiming"

describe("globalApiTiming", () => {
	beforeEach(() => {
		setLastGlobalApiRequestTime(0)
	})

	it("should accept undefined to reset the timer without type cast", () => {
		// First set a value
		setLastGlobalApiRequestTime(12345)
		expect(getLastGlobalApiRequestTime()).toBe(12345)

		// Reset with undefined — this should work without `as any`
		setLastGlobalApiRequestTime(undefined)
		expect(getLastGlobalApiRequestTime()).toBeUndefined()
	})

	it("should accept a number and return it", () => {
		setLastGlobalApiRequestTime(99999)
		expect(getLastGlobalApiRequestTime()).toBe(99999)
	})
})
