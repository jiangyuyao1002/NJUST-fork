import { describe, it, expect } from "vitest"
import { generateImageTool } from "../GenerateImageTool"

describe("GenerateImageTool schema", () => {
	it("passes with valid input", () => {
		const result = generateImageTool.inputSchema.safeParse({ prompt: "A cat", path: "cat.png" })
		expect(result.success).toBe(true)
	})

	it("passes with optional image", () => {
		const result = generateImageTool.inputSchema.safeParse({ prompt: "A cat", path: "cat.png", image: "input.jpg" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = generateImageTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty prompt", () => {
		const result = generateImageTool.inputSchema.safeParse({ prompt: "", path: "cat.png" })
		expect(result.success).toBe(false)
	})
})
