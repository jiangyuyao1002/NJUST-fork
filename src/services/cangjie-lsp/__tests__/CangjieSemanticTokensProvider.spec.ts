import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockParseCangjieDefinitions } = vi.hoisted(() => ({
	mockParseCangjieDefinitions: vi.fn(),
}))

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: mockParseCangjieDefinitions,
}))

const pushedTokens: Array<{ range: any; tokenType: string; modifiers: string[] }> = []

vi.mock("vscode", () => ({
	SemanticTokensLegend: class {
		constructor(
			public tokenTypes: string[],
			public tokenModifiers: string[],
		) {}
	},
	SemanticTokensBuilder: class {
		push(range: any, tokenType: string, modifiers: string[]) {
			pushedTokens.push({ range, tokenType, modifiers })
		}
		build() {
			return { data: new Uint32Array(0) }
		}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

import { CangjieSemanticTokensProvider } from "../CangjieSemanticTokensProvider"

function createMockDocument(lines: string[]) {
	return {
		getText: () => lines.join("\n"),
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
	} as any
}

describe("CangjieSemanticTokensProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		pushedTokens.length = 0
		mockParseCangjieDefinitions.mockReturnValue([])
	})

	it("legend static getter returns legend instance", () => {
		const legend = CangjieSemanticTokensProvider.legend
		expect(legend).toBeDefined()
		expect(legend.tokenTypes).toContain("type")
		expect(legend.tokenTypes).toContain("function")
		expect(legend.tokenModifiers).toContain("declaration")
	})

	it("returns empty tokens for empty document", async () => {
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument([])
		const result = await provider.provideDocumentSemanticTokens(doc)
		expect(result.data).toBeDefined()
		expect(pushedTokens).toHaveLength(0)
	})

	it("generates type token for class definition", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "class", name: "Foo", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["class Foo {", "}"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(1)
		expect(pushedTokens[0].tokenType).toBe("type")
	})

	it("generates function token for func definition", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "func", name: "main", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["func main() {", "}"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(1)
		expect(pushedTokens[0].tokenType).toBe("function")
	})

	it("generates variable token for var definition", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "var", name: "x", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["var x = 42"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(1)
		expect(pushedTokens[0].tokenType).toBe("variable")
	})

	it("generates variable token for let definition", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "let", name: "y", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["let y = 42"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(1)
		expect(pushedTokens[0].tokenType).toBe("variable")
	})

	it("generates namespace token for import", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "import", name: "std.io", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["import std.io"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(1)
		expect(pushedTokens[0].tokenType).toBe("namespace")
	})

	it("skips operator kind (no token type mapping)", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "operator", name: "+", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["operator +() {", "}"])
		await provider.provideDocumentSemanticTokens(doc)
		// operator has no entry in KIND_TO_TOKEN_TYPE, so it's skipped
		expect(pushedTokens).toHaveLength(0)
	})

	it("skips definitions with unsupported kinds", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "unknown", name: "foo", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["foo"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(0)
	})

	it("skips definitions where name not found in line", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "class", name: "NonExistent", startLine: 0 }])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["class Foo {", "}"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(0)
	})

	it("generates tokens for multiple definitions", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "class", name: "A", startLine: 0 },
			{ kind: "func", name: "foo", startLine: 1 },
			{ kind: "let", name: "x", startLine: 2 },
		])
		const provider = new CangjieSemanticTokensProvider()
		const doc = createMockDocument(["class A {", "  func foo() {}", "  let x = 1", "}"])
		await provider.provideDocumentSemanticTokens(doc)
		expect(pushedTokens).toHaveLength(3)
		expect(pushedTokens[0].tokenType).toBe("type")
		expect(pushedTokens[1].tokenType).toBe("function")
		expect(pushedTokens[2].tokenType).toBe("variable")
	})
})
