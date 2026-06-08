import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockParseCangjieDefinitions } = vi.hoisted(() => ({
	mockParseCangjieDefinitions: vi.fn(),
}))

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: mockParseCangjieDefinitions,
}))

vi.mock("vscode", () => ({
	InlayHintKind: { Type: 1, Parameter: 2 },
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

import { CangjieInlayHintsProvider } from "../CangjieInlayHintsProvider"

function createMockDocument(lines: string[]) {
	return {
		getText: () => lines.join("\n"),
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
	} as any
}

describe("CangjieInlayHintsProvider", () => {
	let provider: CangjieInlayHintsProvider

	beforeEach(() => {
		vi.clearAllMocks()
		provider = new CangjieInlayHintsProvider()
		mockParseCangjieDefinitions.mockReturnValue([])
	})

	it("returns empty hints for empty document", async () => {
		const doc = createMockDocument([])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("returns empty hints on cancellation", async () => {
		const doc = createMockDocument(["let x: Int = 1"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: true } as any)
		expect(result).toEqual([])
	})

	it("returns empty hints for document without var/let definitions", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "func", name: "main", startLine: 0, endLine: 2, signature: "func main() {}" },
		])
		const doc = createMockDocument(["func main() {}"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("generates type hint for var declaration with type", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "var", name: "x", startLine: 0, signature: "var x: Int = 42" },
		])
		const doc = createMockDocument(["var x: Int = 42"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toHaveLength(1)
		// Regex captures trailing space: ":\s*(\S[\w<>, ]*)" matches ": Int "
		expect(result[0].label).toMatch(/^: Int/)
		expect(result[0].kind).toBe(1) // Type
		expect(result[0].paddingLeft).toBe(true)
	})

	it("generates type hint for let declaration with type", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "let", name: "name", startLine: 0, signature: 'let name: String = "hello"' },
		])
		const doc = createMockDocument(['let name: String = "hello"'])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toHaveLength(1)
		expect(result[0].label).toMatch(/^: String/)
	})

	it("generates type hint for complex generic type", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "let", name: "map", startLine: 0, signature: "let map: Map<String, Int> = {}" },
		])
		const doc = createMockDocument(["let map: Map<String, Int> = {}"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toHaveLength(1)
		expect(result[0].label).toMatch(/^: Map<String, Int>/)
	})

	it("does not generate hint when signature has no type", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "var", name: "x", startLine: 0, signature: "var x = 42" }])
		const doc = createMockDocument(["var x = 42"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("does not generate hint when definition has no signature", async () => {
		mockParseCangjieDefinitions.mockReturnValue([{ kind: "var", name: "x", startLine: 0 }])
		const doc = createMockDocument(["var x = 42"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("does not generate hint when name not found in line", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "var", name: "nonexistent", startLine: 0, signature: "var nonexistent: Int = 42" },
		])
		const doc = createMockDocument(["var x: Int = 42"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("generates hints for multiple declarations", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "let", name: "a", startLine: 0, signature: "let a: Int = 1" },
			{ kind: "let", name: "b", startLine: 1, signature: 'let b: String = "hi"' },
		])
		const doc = createMockDocument(["let a: Int = 1", 'let b: String = "hi"'])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toHaveLength(2)
		expect(result[0].label).toMatch(/^: Int/)
		expect(result[1].label).toMatch(/^: String/)
	})

	it("correctly positions hint after variable name", async () => {
		mockParseCangjieDefinitions.mockReturnValue([
			{ kind: "let", name: "x", startLine: 0, signature: "let x: Int = 42" },
		])
		const doc = createMockDocument(["let x: Int = 42"])
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toHaveLength(1)
		// "let x" -> name "x" starts at index 4, ends at index 5
		expect(result[0].position.line).toBe(0)
		expect(result[0].position.character).toBe(5) // after "x"
	})
})
