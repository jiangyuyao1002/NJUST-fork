// npx vitest services/tree-sitter/__tests__/inspectSwift.spec.ts

import { it, expect } from "vitest"

import { inspectTreeStructure, testParseSourceCodeDefinitions, debugLog } from "./helpers"
import { swiftQuery } from "../queries"

const runSwiftTreeSitterTests = process.env.RUN_SWIFT_TREE_SITTER_TESTS === "1"

const sampleSwiftContent = String.raw`
class SampleSwiftClass {
    func sampleMethod() -> String {
        return "swift"
    }
}
`

describe.skipIf(!runSwiftTreeSitterTests)("inspectSwift", () => {
	const testOptions = {
		language: "swift",
		wasmFile: "tree-sitter-swift.wasm",
		queryString: swiftQuery,
		extKey: "swift",
	}

	it("should inspect Swift tree structure", async () => {
		// Should execute without throwing
		await expect(inspectTreeStructure(sampleSwiftContent, "swift")).resolves.not.toThrow()
	})

	it("should parse Swift definitions", async () => {
		// This test validates that testParseSourceCodeDefinitions produces output
		const result = await testParseSourceCodeDefinitions("test.swift", sampleSwiftContent, testOptions)
		expect(result).toBeDefined()

		// Check that the output format includes line numbers and content
		if (result) {
			expect(result).toMatch(/\d+--\d+ \| .+/)
			debugLog("Swift parsing test completed successfully")
		}
	}, 15000) // Increase timeout to 15 seconds
})
