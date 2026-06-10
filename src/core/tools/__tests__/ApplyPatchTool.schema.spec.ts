import { describe, it, expect } from "vitest"
import { applyPatchTool } from "../ApplyPatchTool"

describe("ApplyPatchTool schema", () => {
	it("passes with valid input", () => {
		const result = applyPatchTool.inputSchema.safeParse({
			patch: "*** Begin Patch\n*** Update File: test.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n*** End Patch",
		})
		expect(result.success).toBe(true)
	})

	it("fails when required fields are missing", () => {
		const result = applyPatchTool.inputSchema.safeParse({})
		expect(result.success).toBe(false)
	})

	it("fails with empty patch", () => {
		const result = applyPatchTool.inputSchema.safeParse({ patch: "" })
		expect(result.success).toBe(false)
	})
})
