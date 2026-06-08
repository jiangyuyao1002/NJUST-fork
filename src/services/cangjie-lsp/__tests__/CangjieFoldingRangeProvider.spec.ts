import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockParseCangjieDefinitions } = vi.hoisted(() => ({
	mockParseCangjieDefinitions: vi.fn(),
}))

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: mockParseCangjieDefinitions,
}))

vi.mock("vscode", () => ({
	FoldingRange: class {
		constructor(
			public start: number,
			public end: number,
			public kind?: number,
		) {}
	},
	FoldingRangeKind: { Region: 0, Comment: 1, Imports: 3 },
}))

import { CangjieFoldingRangeProvider } from "../CangjieFoldingRangeProvider"

function createMockDocument(lines: string[]) {
	return {
		getText: () => lines.join("\n"),
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
	} as any
}

describe("CangjieFoldingRangeProvider", () => {
	let provider: CangjieFoldingRangeProvider

	beforeEach(() => {
		vi.clearAllMocks()
		provider = new CangjieFoldingRangeProvider()
		mockParseCangjieDefinitions.mockReturnValue([])
	})

	it("returns empty for empty document", () => {
		const doc = createMockDocument([])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		expect(result).toEqual([])
	})

	it("returns empty for document without blocks", () => {
		const doc = createMockDocument(["// comment", "let x = 1"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		expect(result).toEqual([])
	})

	it("returns FoldingRange for class definition", () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "class", name: "Foo", startLine: 0, endLine: 5 }])
		const doc = createMockDocument(["class Foo {", "  let x = 1", "}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const regionRange = result.find((r: any) => r.kind === 0) // Region
		expect(regionRange).toBeDefined()
		expect(regionRange!.start).toBe(0)
		expect(regionRange!.end).toBe(5)
	})

	it("returns FoldingRange for func definition", () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "func", name: "main", startLine: 0, endLine: 3 }])
		const doc = createMockDocument(["func main() {", '  println("hello")', "}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const regionRange = result.find((r: any) => r.kind === 0)
		expect(regionRange).toBeDefined()
		expect(regionRange!.start).toBe(0)
		expect(regionRange!.end).toBe(3)
	})

	it("skips single-line definitions", () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "func", name: "foo", startLine: 2, endLine: 2 }])
		const doc = createMockDocument(["let x = 1", "func foo() { }", "let y = 2"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const regionRange = result.find((r: any) => r.kind === 0)
		expect(regionRange).toBeUndefined()
	})

	it("returns FoldingRange for multiple block kinds", () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "class", name: "A", startLine: 0, endLine: 5 },
			{ kind: "struct", name: "B", startLine: 6, endLine: 10 },
			{ kind: "interface", name: "C", startLine: 11, endLine: 15 },
			{ kind: "enum", name: "D", startLine: 16, endLine: 20 },
		])
		const doc = createMockDocument(Array(21).fill("line"))
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const regionRanges = result.filter((r: any) => r.kind === 0)
		expect(regionRanges).toHaveLength(4)
	})

	it("ignores definitions with unsupported kinds", () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "var", name: "x", startLine: 0, endLine: 1 },
			{ kind: "let", name: "y", startLine: 2, endLine: 3 },
		])
		const doc = createMockDocument(["var x = 1", "let y = 2"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const regionRanges = result.filter((r: any) => r.kind === 0)
		expect(regionRanges).toHaveLength(0)
	})

	it("returns Imports FoldingRange for consecutive imports", () => {
		const doc = createMockDocument(["import std.io", "import std.math", "import std.net", "", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const importRange = result.find((r: any) => r.kind === 3) // Imports
		expect(importRange).toBeDefined()
		expect(importRange!.start).toBe(0)
		expect(importRange!.end).toBe(2)
	})

	it("returns Imports FoldingRange for internal imports", () => {
		const doc = createMockDocument(["internal import std.io", "import std.math", "", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const importRange = result.find((r: any) => r.kind === 3)
		expect(importRange).toBeDefined()
		expect(importRange!.start).toBe(0)
		expect(importRange!.end).toBe(1)
	})

	it("does not create Import range for single import", () => {
		const doc = createMockDocument(["import std.io", "", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const importRange = result.find((r: any) => r.kind === 3)
		expect(importRange).toBeUndefined()
	})

	it("returns Comment FoldingRange for block comment", () => {
		const doc = createMockDocument(["/*", " * multi-line", " * comment", " */", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const commentRange = result.find((r: any) => r.kind === 1) // Comment
		expect(commentRange).toBeDefined()
		expect(commentRange!.start).toBe(0)
		expect(commentRange!.end).toBe(3)
	})

	it("returns Comment FoldingRange for consecutive line comments", () => {
		const doc = createMockDocument(["// line 1", "// line 2", "// line 3", "", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const commentRange = result.find((r: any) => r.kind === 1)
		expect(commentRange).toBeDefined()
		expect(commentRange!.start).toBe(0)
		expect(commentRange!.end).toBe(2)
	})

	it("does not create Comment range for single line comment", () => {
		const doc = createMockDocument(["// single comment", "func main() {}"])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		const commentRange = result.find((r: any) => r.kind === 1)
		expect(commentRange).toBeUndefined()
	})

	it("handles mixed content with block, import, and comment", () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "class", name: "Foo", startLine: 4, endLine: 8 }])
		const doc = createMockDocument([
			"/* block comment",
			"   end */",
			"import std.io",
			"import std.math",
			"class Foo {",
			"  // comment",
			"  func bar() {}",
			"}",
			"// trailing",
		])
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		// Should have: block comment, imports, class
		expect(result.length).toBeGreaterThanOrEqual(3)
	})
})
