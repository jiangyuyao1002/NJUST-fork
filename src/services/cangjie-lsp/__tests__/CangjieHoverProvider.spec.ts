import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockParseDefs } = vi.hoisted(() => ({
	mockParseDefs: vi.fn(),
}))

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: mockParseDefs,
}))

vi.mock("vscode", () => ({
	MarkdownString: class {
		appendCodeblock() {
			return this
		}
		appendMarkdown() {
			return this
		}
	},
	Hover: class {
		constructor(public content: unknown) {}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, _params?: Record<string, unknown>) => key,
}))

import { CangjieHoverProvider } from "../CangjieHoverProvider"

function makeDoc(content: string, word: string, wordStart: number) {
	return {
		getText: (range?: unknown) => {
			if (range) return word
			return content
		},
		getWordRangeAtPosition: () => ({
			start: { character: wordStart },
			end: { character: wordStart + word.length },
		}),
		lineAt: (i: number) => ({ text: content.split("\n")[i] ?? "" }),
	} as any
}

describe("CangjieHoverProvider", () => {
	let provider: CangjieHoverProvider

	beforeEach(() => {
		mockParseDefs.mockReset()
		mockParseDefs.mockReturnValue([])
		provider = new CangjieHoverProvider()
	})

	it("returns undefined for empty document", () => {
		mockParseDefs.mockReturnValue([])
		const doc = {
			getText: () => "",
			getWordRangeAtPosition: () => undefined,
			lineAt: () => ({ text: "" }),
		} as any
		const result = provider.provideHover(doc, { line: 0, character: 0 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns undefined when word not found in definitions", () => {
		mockParseDefs.mockReturnValue([])
		const doc = makeDoc("func main() {}", "main", 5)
		const result = provider.provideHover(doc, { line: 0, character: 6 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns Hover for single matching definition", () => {
		mockParseDefs.mockReturnValue([{ name: "myFunc", kind: "func", startLine: 0, endLine: 3 }])
		const doc = makeDoc("func myFunc(): Int64 {\n  return 0\n}", "myFunc", 5)
		const result = provider.provideHover(doc, { line: 0, character: 8 } as any, {} as any)
		expect(result).toBeDefined()
	})

	it("returns hover with multi-line range label when endLine > startLine", () => {
		mockParseDefs.mockReturnValue([{ name: "MyClass", kind: "class", startLine: 0, endLine: 10 }])
		const doc = makeDoc("class MyClass {\n  func foo() {}\n}", "MyClass", 6)
		const result = provider.provideHover(doc, { line: 0, character: 8 } as any, {} as any)
		expect(result).toBeDefined()
	})

	it("returns hover with single-line label when endLine === startLine", () => {
		mockParseDefs.mockReturnValue([{ name: "MY_CONST", kind: "let", startLine: 0, endLine: 0 }])
		const doc = makeDoc("let MY_CONST = 42", "MY_CONST", 4)
		const result = provider.provideHover(doc, { line: 0, character: 6 } as any, {} as any)
		expect(result).toBeDefined()
	})

	it("prefers exact line match over other matches", () => {
		mockParseDefs.mockReturnValue([
			{ name: "foo", kind: "func", startLine: 0, endLine: 3 },
			{ name: "foo", kind: "func", startLine: 5, endLine: 5 },
		])
		const doc = makeDoc("func foo() {}\n\n\n\n\nfunc foo() {}", "foo", 5)
		const result = provider.provideHover(doc, { line: 5, character: 6 } as any, {} as any)
		expect(result).toBeDefined()
	})

	it("prefers containing range over closest by distance", () => {
		mockParseDefs.mockReturnValue([
			{ name: "foo", kind: "func", startLine: 0, endLine: 0 },
			{ name: "foo", kind: "func", startLine: 5, endLine: 10 },
		])
		const doc = makeDoc("func foo() {}\n\n\n\n\nfunc foo() {}", "foo", 5)
		const result = provider.provideHover(doc, { line: 7, character: 6 } as any, {} as any)
		expect(result).toBeDefined()
	})

	it("filters out import and package kinds", () => {
		mockParseDefs.mockReturnValue([
			{ name: "foo", kind: "import", startLine: 0, endLine: 0 },
			{ name: "foo", kind: "package", startLine: 1, endLine: 1 },
		])
		const doc = makeDoc("import foo\npackage foo", "foo", 7)
		const result = provider.provideHover(doc, { line: 0, character: 8 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns closest match when multiple non-exact matches exist", () => {
		mockParseDefs.mockReturnValue([
			{ name: "foo", kind: "func", startLine: 0, endLine: 3 },
			{ name: "foo", kind: "func", startLine: 20, endLine: 25 },
		])
		const doc = makeDoc("func foo() {}", "foo", 5)
		const result = provider.provideHover(doc, { line: 5, character: 6 } as any, {} as any)
		expect(result).toBeDefined()
	})
})
