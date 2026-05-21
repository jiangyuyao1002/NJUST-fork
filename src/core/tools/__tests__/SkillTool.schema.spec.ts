import { describe, it, expect } from "vitest"
import { skillTool } from "../SkillTool"

describe("SkillTool schema", () => {
	it("passes with valid input", () => {
		const result = skillTool.inputSchema.safeParse({ skill: "my-skill" })
		expect(result.success).toBe(true)
	})

	it("passes with optional args", () => {
		const result = skillTool.inputSchema.safeParse({ skill: "my-skill", args: "--verbose" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = skillTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty skill", () => {
		const result = skillTool.inputSchema.safeParse({ skill: "" })
		expect(result.success).toBe(false)
	})
})
