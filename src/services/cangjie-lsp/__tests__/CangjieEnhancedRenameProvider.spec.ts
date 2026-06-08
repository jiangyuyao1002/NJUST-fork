import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
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
	Uri: { file: (p: string) => ({ fsPath: p }) },
	WorkspaceEdit: class {
		replace() {}
		insert() {}
		delete() {}
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, promises: { ...actual.promises, readdir: vi.fn().mockResolvedValue([]) } },
	}
})

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieEnhancedRenameProvider } from "../CangjieEnhancedRenameProvider"

describe("CangjieEnhancedRenameProvider", () => {
	let provider: CangjieEnhancedRenameProvider
	let mockIndex: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockIndex = {
			findDefinitions: vi.fn().mockReturnValue([]),
			findReferences: vi.fn().mockReturnValue([]),
		}
		provider = new CangjieEnhancedRenameProvider(mockIndex)
	})

	describe("prepareRename", () => {
		it("returns undefined when no word at position", () => {
			const doc = { getWordRangeAtPosition: () => undefined, getText: () => "" } as any
			const result = provider.prepareRename(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toBeUndefined()
		})

		it("returns undefined for single char word", () => {
			const doc = {
				getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 1 } }),
				getText: () => "x",
			} as any
			const result = provider.prepareRename(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toBeUndefined()
		})

		it("returns undefined when no definitions found", () => {
			mockIndex.findDefinitions.mockReturnValue([])
			const doc = {
				getWordRangeAtPosition: () => ({ start: { character: 0 }, end: { character: 5 } }),
				getText: () => "myVar",
			} as any
			const result = provider.prepareRename(doc, { line: 0, character: 2 } as any, {} as any)
			expect(result).toBeUndefined()
		})

		it("returns word range when definitions found", () => {
			mockIndex.findDefinitions.mockReturnValue([
				{ filePath: "/ws/test.cj", startLine: 0, signature: "func foo" },
			])
			const wordRange = { start: { character: 0 }, end: { character: 3 } }
			const doc = { getWordRangeAtPosition: () => wordRange, getText: () => "foo" } as any
			const result = provider.prepareRename(doc, { line: 0, character: 1 } as any, {} as any)
			expect(result).toBe(wordRange)
		})
	})
})
