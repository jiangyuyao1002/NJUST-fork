import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	Location: class {
		constructor(
			public uri: unknown,
			public range: unknown,
		) {}
	},
	Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
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

import { CangjieDefinitionProvider } from "../CangjieDefinitionProvider"

describe("CangjieDefinitionProvider", () => {
	let provider: CangjieDefinitionProvider
	let mockIndex: any

	beforeEach(() => {
		mockIndex = { findDefinitions: vi.fn().mockReturnValue([]) }
		provider = new CangjieDefinitionProvider(mockIndex)
	})

	it("returns undefined when no word at position", () => {
		const doc = { getWordRangeAtPosition: () => undefined, getText: () => "", uri: {} } as any
		const result = provider.provideDefinition(doc, { line: 0, character: 0 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns undefined for single char word", () => {
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 1 } }),
			getText: () => "x",
			uri: {},
		} as any
		const result = provider.provideDefinition(doc, { line: 0, character: 0 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns undefined when no definitions found", () => {
		mockIndex.findDefinitions.mockReturnValue([])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 5 } }),
			getText: () => "myVar",
			uri: {},
		} as any
		const result = provider.provideDefinition(doc, { line: 0, character: 2 } as any, {} as any)
		expect(result).toBeUndefined()
	})

	it("returns locations when definitions found", () => {
		mockIndex.findDefinitions.mockReturnValue([
			{ filePath: "/ws/other.cj", startLine: 5, signature: "func foo() {}" },
		])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 3 } }),
			getText: () => "foo",
			uri: {},
		} as any
		const result = provider.provideDefinition(doc, { line: 0, character: 1 } as any, {} as any)
		expect(result).toBeDefined()
		expect(result!.length).toBe(1)
	})
})
