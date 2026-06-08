import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	SymbolInformation: class {
		constructor(
			public name: string,
			public kind: number,
			public detail: string,
			public location: unknown,
		) {}
	},
	SymbolKind: {
		Class: 4,
		Struct: 23,
		Interface: 11,
		Enum: 10,
		Function: 12,
		Variable: 13,
		Property: 7,
		Package: 4,
		Module: 2,
		TypeParameter: 25,
		Constructor: 9,
		Operator: 15,
		EnumMember: 22,
		Object: 14,
	},
	Location: class {
		constructor(
			public uri: unknown,
			public range: unknown,
		) {}
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

import { CangjieWorkspaceSymbolProvider } from "../CangjieWorkspaceSymbolProvider"

describe("CangjieWorkspaceSymbolProvider", () => {
	let provider: CangjieWorkspaceSymbolProvider
	let mockIndex: any

	beforeEach(() => {
		mockIndex = { findSymbolsByPrefix: vi.fn().mockReturnValue([]) }
		provider = new CangjieWorkspaceSymbolProvider(mockIndex)
	})

	it("returns empty for short query", async () => {
		const result = await provider.provideWorkspaceSymbols("a", {} as any)
		expect(result).toEqual([])
	})

	it("returns empty for empty query", async () => {
		const result = await provider.provideWorkspaceSymbols("", {} as any)
		expect(result).toEqual([])
	})

	it("returns symbols for valid query", async () => {
		mockIndex.findSymbolsByPrefix.mockReturnValue([
			{
				name: "MyClass",
				kind: "class",
				filePath: "/ws/main.cj",
				startLine: 0,
				endLine: 10,
				signature: "class MyClass",
			},
		])
		const result = await provider.provideWorkspaceSymbols("MyCl", {} as any)
		expect(result.length).toBe(1)
		expect(result[0].name).toBe("MyClass")
	})
})
