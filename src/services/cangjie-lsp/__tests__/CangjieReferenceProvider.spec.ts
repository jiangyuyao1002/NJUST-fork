import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	Location: class {
		uri: unknown
		range: unknown
		constructor(uri: unknown, positionOrRange: unknown) {
			this.uri = uri
			if (
				positionOrRange &&
				typeof positionOrRange === "object" &&
				"line" in positionOrRange &&
				!("start" in positionOrRange)
			) {
				this.range = { start: positionOrRange, end: positionOrRange }
			} else {
				this.range = positionOrRange
			}
		}
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

import { CangjieReferenceProvider } from "../CangjieReferenceProvider"

describe("CangjieReferenceProvider", () => {
	let provider: CangjieReferenceProvider
	let mockIndex: any

	beforeEach(() => {
		mockIndex = {
			findReferences: vi.fn().mockReturnValue([]),
			findDefinitions: vi.fn().mockReturnValue([]),
		}
		provider = new CangjieReferenceProvider(mockIndex)
	})

	it("returns undefined when no word at position", () => {
		const doc = { getWordRangeAtPosition: () => undefined, getText: () => "", uri: {} } as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 0 } as any,
			{ includeDeclaration: true } as any,
			{} as any,
		)
		expect(result).toBeUndefined()
	})

	it("returns undefined when word is too short", () => {
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 1 } }),
			getText: () => "x",
			uri: {},
		} as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 0 } as any,
			{ includeDeclaration: true } as any,
			{} as any,
		)
		expect(result).toBeUndefined()
	})

	it("returns undefined when no references found", () => {
		mockIndex.findReferences.mockReturnValue([])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 5 } }),
			getText: () => "myVar",
			uri: {},
		} as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 2 } as any,
			{ includeDeclaration: true } as any,
			{} as any,
		)
		expect(result).toBeUndefined()
	})

	it("returns locations when references found with includeDeclaration=true", () => {
		mockIndex.findReferences.mockReturnValue([
			{ filePath: "/ws/a.cj", line: 5, column: 10 },
			{ filePath: "/ws/b.cj", line: 3, column: 0 },
		])
		mockIndex.findDefinitions.mockReturnValue([{ filePath: "/ws/a.cj", startLine: 5 }])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 3 } }),
			getText: () => "foo",
			uri: { fsPath: "/ws/a.cj" },
		} as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 1 } as any,
			{ includeDeclaration: true } as any,
			{} as any,
		)
		expect(result).toBeDefined()
		expect(result!.length).toBe(2)
	})

	it("filters out definition locations when includeDeclaration=false", () => {
		mockIndex.findReferences.mockReturnValue([
			{ filePath: "/ws/a.cj", line: 5, column: 10 },
			{ filePath: "/ws/b.cj", line: 3, column: 0 },
		])
		mockIndex.findDefinitions.mockReturnValue([{ filePath: "/ws/a.cj", startLine: 5 }])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 3 } }),
			getText: () => "foo",
			uri: { fsPath: "/ws/a.cj" },
		} as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 1 } as any,
			{ includeDeclaration: false } as any,
			{} as any,
		)
		expect(result).toBeDefined()
		expect(result!.length).toBe(1)
	})

	it("returns all references when includeDeclaration=false but no definitions match", () => {
		mockIndex.findReferences.mockReturnValue([
			{ filePath: "/ws/a.cj", line: 5, column: 10 },
			{ filePath: "/ws/b.cj", line: 3, column: 0 },
		])
		mockIndex.findDefinitions.mockReturnValue([])
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 3 } }),
			getText: () => "foo",
			uri: { fsPath: "/ws/a.cj" },
		} as any
		const result = provider.provideReferences(
			doc,
			{ line: 0, character: 1 } as any,
			{ includeDeclaration: false } as any,
			{} as any,
		)
		expect(result).toBeDefined()
		expect(result!.length).toBe(2)
	})

	it("calls findReferences with correct word and scopeUri", () => {
		mockIndex.findReferences.mockReturnValue([{ filePath: "/ws/a.cj", line: 0, column: 0 }])
		const uri = { fsPath: "/ws/test.cj" }
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 4 }, end: { character: 10 } }),
			getText: () => "myFunc",
			uri,
		} as any
		provider.provideReferences(
			doc,
			{ line: 0, character: 6 } as any,
			{ includeDeclaration: true } as any,
			{} as any,
		)
		expect(mockIndex.findReferences).toHaveBeenCalledWith("myFunc", uri)
	})

	it("calls findDefinitions when includeDeclaration=false", () => {
		mockIndex.findReferences.mockReturnValue([{ filePath: "/ws/a.cj", line: 0, column: 0 }])
		mockIndex.findDefinitions.mockReturnValue([])
		const uri = { fsPath: "/ws/test.cj" }
		const doc = {
			getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 3 } }),
			getText: () => "foo",
			uri,
		} as any
		provider.provideReferences(
			doc,
			{ line: 0, character: 1 } as any,
			{ includeDeclaration: false } as any,
			{} as any,
		)
		expect(mockIndex.findDefinitions).toHaveBeenCalledWith("foo", uri)
	})
})
