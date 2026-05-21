import { describe, it, expect } from "vitest"
import { switchModeTool } from "../SwitchModeTool"

describe("SwitchModeTool schema", () => {
	it("passes with valid input", () => {
		const result = switchModeTool.inputSchema.safeParse({ mode_slug: "code", reason: "test" })
		expect(result.success).toBe(true)
	})

	it("passes without optional reason", () => {
		const result = switchModeTool.inputSchema.safeParse({ mode_slug: "code" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = switchModeTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty mode_slug", () => {
		const result = switchModeTool.inputSchema.safeParse({ mode_slug: "" })
		expect(result.success).toBe(false)
	})
})
