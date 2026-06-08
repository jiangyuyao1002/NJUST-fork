import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	SymbolKind: { Constructor: 9, Function: 12, Interface: 11, Enum: 10, Class: 4 },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
}))

vi.mock("../../tree-sitter/cangjieParser", () => ({}))

import { CangjieCallHierarchyProvider } from "../CangjieCallHierarchyProvider"

describe("CangjieCallHierarchyProvider", () => {
	let provider: CangjieCallHierarchyProvider
	let mockIndex: any

	beforeEach(() => {
		mockIndex = {
			findEnclosingSymbol: vi.fn().mockReturnValue(null),
			findReferences: vi.fn().mockReturnValue([]),
			findDefinitions: vi.fn().mockReturnValue([]),
		}
		provider = new CangjieCallHierarchyProvider(mockIndex)
	})

	describe("prepareCallHierarchy", () => {
		it("returns empty when no enclosing symbol", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue(null)
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareCallHierarchy(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns empty when symbol is not callable", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue({ name: "MyClass", kind: "class" })
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareCallHierarchy(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns item for callable symbol", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue({
				name: "myFunc",
				kind: "func",
				filePath: "/ws/test.cj",
				startLine: 0,
				endLine: 5,
				signature: "func myFunc() {}",
			})
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareCallHierarchy(doc, { line: 2, character: 5 } as any, {} as any)
			expect(result.length).toBe(1)
			expect(result[0].name).toBe("myFunc")
		})
	})

	describe("provideCallHierarchyIncomingCalls", () => {
		it("returns empty when no references", async () => {
			mockIndex.findReferences.mockReturnValue([])
			const item = { name: "myFunc", uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.provideCallHierarchyIncomingCalls(item, {} as any)
			expect(result).toEqual([])
		})
	})
})
