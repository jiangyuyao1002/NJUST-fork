import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	CodeAction: class {
		constructor(
			public title: string,
			public kind: unknown,
		) {}
	},
	CodeActionKind: {
		RefactorExtract: { value: "refactor.extract" },
		Refactor: { value: "refactor" },
	},
	window: {
		showInputBox: vi.fn(),
		showInformationMessage: vi.fn(),
		activeTextEditor: undefined,
	},
	workspace: {
		applyEdit: vi.fn(),
		workspaceEdit: vi.fn(),
	},
	WorkspaceEdit: class {
		replace() {}
		insert() {}
		delete() {}
	},
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
	Selection: class {
		constructor(
			public anchor: unknown,
			public active: unknown,
		) {}
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, readFileSync: vi.fn().mockReturnValue("") },
		readFileSync: vi.fn().mockReturnValue(""),
	}
})

vi.mock("../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieRefactoringProvider } from "../CangjieRefactoringProvider"

describe("CangjieRefactoringProvider", () => {
	let provider: CangjieRefactoringProvider
	let mockIndex: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockIndex = { findDefinitions: vi.fn().mockReturnValue([]) }
		provider = new CangjieRefactoringProvider(mockIndex)
	})

	describe("provideCodeActions", () => {
		it("returns empty array when range is empty", () => {
			const doc = { getText: () => "", uri: {} } as any
			const range = { isEmpty: true } as any
			const result = provider.provideCodeActions(doc, range, { diagnostics: [] } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns extract action when range is not empty", () => {
			const doc = { getText: () => "let x = 1", uri: {} } as any
			const range = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 9 } } as any
			const result = provider.provideCodeActions(doc, range, { diagnostics: [] } as any, {} as any)
			expect(result.length).toBe(1)
			expect(result[0].title).toContain("Extract")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => provider.dispose()).not.toThrow()
		})
	})
})
