import { describe, it, expect } from "vitest"
import { applyDiffTool } from "../ApplyDiffTool"

describe("ApplyDiffTool schema", () => {
	it("passes with valid input", () => {
		const result = applyDiffTool.inputSchema.safeParse({ path: "test.txt", diff: "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new" })
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = applyDiffTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty path", () => {
		const result = applyDiffTool.inputSchema.safeParse({ path: "", diff: "some diff" })
		expect(result.success).toBe(false)
	})

	it("fails with empty diff", () => {
		const result = applyDiffTool.inputSchema.safeParse({ path: "test.txt", diff: "" })
		expect(result.success).toBe(false)
	})
})
