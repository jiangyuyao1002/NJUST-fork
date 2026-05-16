import { readFile } from "fs/promises"
import { describe, expect, it } from "vitest"

describe("Task system prompt cache inheritance", () => {
	it("keeps Task module importable after cache inheritance changes", async () => {
		const source = await readFile(new URL("../Task.ts", import.meta.url), "utf8")

		expect(source).toContain("this.requestBuilder = new TaskRequestBuilder")
		expect(source).toContain("this.requestBuilder.inheritCacheFromParent(parentTask)")
		expect(source).toContain("private async getSystemPromptParts(): Promise<SystemPromptParts>")
		expect(source).toContain("private async getSystemPrompt(): Promise<string>")
	})
})
