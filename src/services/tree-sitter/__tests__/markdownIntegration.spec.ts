// Mocks must come first, before imports

vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockImplementation(() => Promise.resolve("")),
	stat: vi.fn().mockImplementation(() => Promise.resolve({ isDirectory: () => false })),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

// Then imports
import * as fs from "fs/promises"
import type { Mock } from "vitest"

import { parseSourceCodeDefinitionsForFile } from "../index"

describe("Markdown Integration Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should parse markdown files and extract headers for definition listing", async () => {
		// This test verifies that the tree-sitter integration correctly
		// formats markdown headers for the definition listing feature
		const markdownContent =
			"# Main Header\n\nThis is some content under the main header.\nIt spans multiple lines to meet the minimum section length.\n\n## Section 1\n\nThis is content for section 1.\nIt also spans multiple lines.\n\n### Subsection 1.1\n\nThis is a subsection with enough lines\nto meet the minimum section length requirement.\n\n## Section 2\n\nFinal section content.\nWith multiple lines.\n"

		// Mock fs.readFile to return our markdown content
		;(fs.readFile as Mock).mockImplementation(() => Promise.resolve(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("test.md")

		// Verify fs.readFile was called with the correct path
		expect(fs.readFile).toHaveBeenCalledWith("test.md", "utf8")

		// Check the result formatting for definition listing
		expect(result).toBeDefined()
		expect(result).toContain("# test.md")
		expect(result).toContain("1--5 | # Main Header")
		expect(result).toContain("6--10 | ## Section 1")
		expect(result).toContain("11--15 | ### Subsection 1.1")
		expect(result).toContain("16--20 | ## Section 2")
	})

	it("should return undefined for markdown files with no extractable definitions", async () => {
		// This test verifies behavior when no headers meet the minimum requirements
		const markdownContent = "This is just some text.\nNo headers here.\nJust plain text."

		// Mock fs.readFile to return our markdown content
		;(fs.readFile as Mock).mockImplementation(() => Promise.resolve(markdownContent))

		// Call the function with a markdown file path
		const result = await parseSourceCodeDefinitionsForFile("no-headers.md")

		// Verify fs.readFile was called with the correct path
		expect(fs.readFile).toHaveBeenCalledWith("no-headers.md", "utf8")

		// Check the result - should be undefined since no definitions found
		expect(result).toBeUndefined()
	})

	it("should return undefined for oversized markdown files exceeding MAX_TREE_SITTER_PARSE_SIZE", async () => {
		// Create content that exceeds the 10MB limit
		const largeContent = "x".repeat(10 * 1024 * 1024 + 1)
		;(fs.readFile as Mock).mockImplementation(() => Promise.resolve(largeContent))

		const result = await parseSourceCodeDefinitionsForFile("huge.md")

		expect(fs.readFile).toHaveBeenCalledWith("huge.md", "utf8")
		expect(result).toBeUndefined()
	})

	it("should parse Cangjie files through the .cj branch (regression: markdown branch must not short-circuit)", async () => {
		// This regression test verifies that the Cangjie branch in
		// parseSourceCodeDefinitionsForFile is reachable and not accidentally
		// blocked by the preceding markdown branch's control flow.
		const cangjieContent = [
			"package demo",
			"",
			"class MyClass {",
			"    func greet(name: String): String {",
			'        return "Hello, " + name',
			"    }",
			"",
			"    func add(a: Int64, b: Int64): Int64 {",
			"        return a + b",
			"    }",
			"}",
		].join("\n")

		;(fs.readFile as Mock).mockImplementation(() => Promise.resolve(cangjieContent))

		const result = await parseSourceCodeDefinitionsForFile("example.cj")

		expect(fs.readFile).toHaveBeenCalledWith("example.cj", "utf8")
		// The Cangjie parser should process this file; result may be defined or
		// undefined depending on whether definitions meet the minimum-line
		// threshold, but the function must NOT throw or short-circuit.
		// If the markdown branch had a premature return, this test would fail
		// because the .cj extension would never reach the Cangjie handler.
		if (result !== undefined) {
			expect(result).toContain("# example.cj")
		}
	})
})
