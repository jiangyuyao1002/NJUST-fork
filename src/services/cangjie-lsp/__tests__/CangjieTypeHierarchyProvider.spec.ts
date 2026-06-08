import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	SymbolKind: { Interface: 11, Enum: 10, Class: 4 },
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

import { CangjieTypeHierarchyProvider } from "../CangjieTypeHierarchyProvider"

describe("CangjieTypeHierarchyProvider", () => {
	let provider: CangjieTypeHierarchyProvider
	let mockIndex: any

	beforeEach(() => {
		mockIndex = {
			findEnclosingSymbol: vi.fn().mockReturnValue(null),
			findDefinitions: vi.fn().mockReturnValue([]),
			getReverseDependencies: vi.fn().mockReturnValue([]),
			getSymbolsByFile: vi.fn().mockReturnValue([]),
		}
		provider = new CangjieTypeHierarchyProvider(mockIndex)
	})

	describe("prepareTypeHierarchy", () => {
		it("returns empty when no enclosing symbol", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue(null)
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareTypeHierarchy(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns empty when symbol is not a type", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue({ name: "myFunc", kind: "func" })
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareTypeHierarchy(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns item for type symbol", async () => {
			mockIndex.findEnclosingSymbol.mockReturnValue({
				name: "MyClass",
				kind: "class",
				filePath: "/ws/test.cj",
				startLine: 0,
				endLine: 10,
				signature: "class MyClass",
			})
			const doc = { uri: { fsPath: "/ws/test.cj" } } as any
			const result = await provider.prepareTypeHierarchy(doc, { line: 5, character: 5 } as any, {} as any)
			expect(result.length).toBe(1)
			expect(result[0].name).toBe("MyClass")
		})
	})
})
