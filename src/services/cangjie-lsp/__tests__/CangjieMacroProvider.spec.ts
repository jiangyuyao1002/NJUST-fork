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

describe("CangjieMacroProvider", () => {
	let mockIndex: any
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockIndex = {
			findEnclosingSymbol: vi.fn().mockReturnValue(null),
			findDefinitions: vi.fn().mockReturnValue([]),
		}
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
	})

	describe("CangjieMacroCodeLensProvider", () => {
		it("returns empty lenses for document without macros", () => {
			const provider = new CangjieMacroCodeLensProvider(mockIndex)
			const doc = {
				getText: () => "func main() {}",
				lineCount: 1,
				lineAt: () => ({ text: "func main() {}" }),
			} as any
			const result = provider.provideCodeLenses(doc, {} as any)
			expect(result).toEqual([])
		})
	})

	describe("CangjieMacroHoverProvider", () => {
		it("returns undefined for non-macro hover", () => {
			const provider = new CangjieMacroHoverProvider(mockIndex, mockOutput)
			const doc = {
				getText: () => "func main() {}",
				getWordRangeAtPosition: () => undefined,
				lineAt: (_line: number) => ({ text: "func main() {}" }),
			} as any
			const result = provider.provideHover(doc, { line: 0, character: 0 } as any, {} as any)
			expect(result).toBeUndefined()
		})
	})
})
