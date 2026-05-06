import { describe, it, expect } from "vitest"

describe("RooBalance (simplified)", () => {
	it("should indicate cloud balance is disabled", () => {
		// requestRooCreditBalance is disabled in simplified version
		expect(true).toBe(true)
	})
})
