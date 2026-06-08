import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	CodeLens: class {
		constructor(
			public range: unknown,
			public command: unknown,
		) {}
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
	Uri: { file: (p: string) => ({ fsPath: p }) },
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
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	CJC_CONFIG_KEY: "cangjieTools.cjcPath",
}))

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn() },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieMacroCodeLensProvider, CangjieMacroHoverProvider } from "../CangjieMacroProvider"

function createMockDocument(lines: string[]) {
	return {
		getText: () => lines.join("\n"),
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
		getWordRangeAtPosition: vi.fn().mockReturnValue(undefined),
	} as any
}

describe("CangjieMacroProvider", () => {
	let mockIndex: any
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockIndex = {
			findEnclosingSymbol: vi.fn().mockReturnValue(null),
			findDefinitions: vi.fn().mockReturnValue([]),
			findDefinitionsByKind: vi.fn().mockReturnValue([]),
		}
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
	})

	describe("CangjieMacroCodeLensProvider", () => {
		it("returns empty lenses for document without macros", () => {
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = createMockDocument(["func main() {}"])
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result).toEqual([])
		})

		it("generates Expand Macro lens for custom macro call", () => {
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = createMockDocument(["@MyMacro", "func main() {}"])
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result.length).toBeGreaterThanOrEqual(1)
			// Should have "Expand Macro" lens
			const expandLens = result.find((l: any) => l.command?.title?.includes("expand_macro"))
			expect(expandLens).toBeDefined()
		})

		it("generates Go to Macro Definition lens when definition found", () => {
			mockIndex.findDefinitionsByKind.mockReturnValue([{ filePath: "/test/macro.cj", startLine: 5 }])
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = createMockDocument(["@MyMacro", "func main() {}"])
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result.length).toBeGreaterThanOrEqual(2)
			// Should have "Go to Macro Definition" lens
			const gotoLens = result.find((l: any) => l.command?.title?.includes("go_to_macro_def"))
			expect(gotoLens).toBeDefined()
		})

		it("filters built-in annotations", () => {
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = createMockDocument(["@Test", "@TestCase", "@Assert", "@Deprecated", "@Suppress", "@Override"])
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result).toEqual([])
		})

		it("handles multiple macro calls on different lines", () => {
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = createMockDocument(["@Macro1", "func foo() {}", "@Macro2", "func bar() {}"])
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result.length).toBeGreaterThanOrEqual(2)
		})
	})

	describe("CangjieMacroHoverProvider", () => {
		it("returns undefined for non-macro hover", () => {
			const provider = new CangjieMacroHoverProvider(mockIndex, mockOutput)
			const doc = createMockDocument(["func main() {}"])
			const result = provider.provideHover(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toBeUndefined()
		})

		it("returns hover for macro call when cursor is on macro name", () => {
			mockIndex.findDefinitionsByKind.mockReturnValue([
				{ filePath: "/test/macro.cj", startLine: 5, signature: "macro MyMacro() {}" },
			])
			const provider = new CangjieMacroHoverProvider(mockIndex, mockOutput)
			const doc = createMockDocument(["@MyMacro func main() {}"])
			// Cursor on 'M' of MyMacro (position 1)
			const result = provider.provideHover(doc, { line: 0, character: 1 } as any, {} as any)
			expect(result).toBeDefined()
		})

		it("returns undefined when cursor is not on macro call", () => {
			const provider = new CangjieMacroHoverProvider(mockIndex, mockOutput)
			const doc = createMockDocument(["@MyMacro func main() {}"])
			// Cursor on 'f' of func (position 10)
			const result = provider.provideHover(doc, { line: 0, character: 10 } as any, {} as any)
			expect(result).toBeUndefined()
		})

		it("shows hover for built-in annotations (no filtering in hover provider)", () => {
			const provider = new CangjieMacroHoverProvider(mockIndex, mockOutput)
			const doc = createMockDocument(["@Test func main() {}"])
			// Cursor on 'T' of Test
			const result = provider.provideHover(doc, { line: 0, character: 1 } as any, {} as any)
			// Hover provider does NOT filter built-in annotations (unlike CodeLens provider)
			expect(result).toBeDefined()
		})
	})
})
