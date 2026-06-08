import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("vscode", () => ({
	DocumentSymbol: class {
		constructor(
			public name: string,
			public detail: string,
			public kind: number,
			public range: unknown,
			public selectionRange: unknown,
		) {
			this.children = []
		}
		children: unknown[]
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	SymbolKind: {
		Class: 4,
		Struct: 23,
		Interface: 11,
		Enum: 10,
		Function: 12,
		Namespace: 2,
		Variable: 13,
		TypeParameter: 25,
		Package: 4,
		Module: 2,
		Property: 7,
		Constructor: 9,
		Operator: 15,
		EnumMember: 22,
	},
}))

import { parseCangjieDefinitions } from "../../tree-sitter/cangjieParser"
import { CangjieDocumentSymbolProvider } from "../CangjieDocumentSymbolProvider"

describe("CangjieDocumentSymbolProvider", () => {
	let provider: CangjieDocumentSymbolProvider

	beforeEach(() => {
		vi.clearAllMocks()
		provider = new CangjieDocumentSymbolProvider()
	})

	it("returns empty for empty document", () => {
		vi.mocked(parseCangjieDefinitions).mockReturnValue([])
		const doc = { getText: () => "", lineCount: 1, lineAt: () => ({ text: "" }) } as any
		const result = provider.provideDocumentSymbols(doc, {} as any)
		expect(result).toEqual([])
	})

	it("returns symbols for definitions", () => {
		vi.mocked(parseCangjieDefinitions).mockReturnValue([
			{ name: "MyClass", kind: "class", startLine: 0, endLine: 5 },
			{ name: "myFunc", kind: "func", startLine: 6, endLine: 8 },
		] as any)
		const doc = {
			getText: () => "class MyClass {\n  func myFunc() {}\n}",
			lineCount: 3,
			lineAt: () => ({ text: "class MyClass {}" }),
		} as any
		const result = provider.provideDocumentSymbols(doc, {} as any)
		expect(result.length).toBe(2)
	})

	it("filters out import definitions", () => {
		vi.mocked(parseCangjieDefinitions).mockReturnValue([
			{ name: "std.io", kind: "import", startLine: 0, endLine: 0 },
			{ name: "MyClass", kind: "class", startLine: 1, endLine: 5 },
		] as any)
		const doc = {
			getText: () => "import std.io.*\nclass MyClass {}",
			lineCount: 2,
			lineAt: () => ({ text: "" }),
		} as any
		const result = provider.provideDocumentSymbols(doc, {} as any)
		expect(result.length).toBe(1)
	})
})
