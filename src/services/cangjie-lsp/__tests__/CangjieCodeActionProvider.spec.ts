import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	CodeAction: class {
		edit: unknown
		diagnostics: unknown
		isPreferred: boolean
		constructor(
			public title: string,
			public kind: unknown,
		) {
			this.edit = undefined
			this.diagnostics = []
			this.isPreferred = false
		}
	},
	CodeActionKind: { QuickFix: { value: "quickfix" } },
	DiagnosticSeverity: { Error: 0, Warning: 1 },
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
	Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
	WorkspaceEdit: class {
		private edits: Array<{ uri: unknown; pos: unknown; text: string }> = []
		insert(_uri: unknown, pos: unknown, text: string) {
			this.edits.push({ uri: _uri, pos, text })
		}
		replace() {}
		delete() {}
		getEdits() {
			return this.edits
		}
	},
}))

vi.mock("../cangjieSourceLayout", () => ({
	inferCangjiePackageFromSrcLayout: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, params?: Record<string, unknown>) => {
		if (params) return `${key}:${JSON.stringify(params)}`
		return key
	},
}))

import { CangjieCodeActionProvider } from "../CangjieCodeActionProvider"

function makeDiagnostic(line: number, message: string) {
	return {
		range: { start: { line, character: 0 }, end: { line, character: 10 } },
		message,
		severity: 0,
		source: "",
	} as any
}

function makeDoc(lines: string[]) {
	return {
		getText: (range?: unknown) => {
			if (range) {
				const r = range as any
				return lines[r.start.line]?.substring(r.start.character, r.end.character) ?? ""
			}
			return lines.join("\n")
		},
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
		uri: { fsPath: "/ws/test.cj" },
		lineCount: lines.length,
	} as any
}

describe("CangjieCodeActionProvider", () => {
	let provider: CangjieCodeActionProvider

	beforeEach(() => {
		provider = new CangjieCodeActionProvider()
	})

	it("returns empty array for no diagnostics", () => {
		const doc = makeDoc([""])
		const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } as any
		const result = provider.provideCodeActions(doc, range, { diagnostics: [] } as any, {} as any)
		expect(result).toEqual([])
	})

	describe("undeclared/not found → add import", () => {
		it("creates import action for known stdlib symbol (ArrayList → std.collection)", () => {
			const doc = makeDoc(["ArrayList"])
			const diag = makeDiagnostic(0, "cannot find `ArrayList`")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const importActions = result.filter((a: any) => a.title?.includes("std.collection"))
			expect(importActions.length).toBe(1)
		})

		it("does not create import when package already imported", () => {
			const doc = makeDoc(["import std.collection {", "ArrayList"])
			const diag = makeDiagnostic(1, "cannot find `ArrayList`")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const importActions = result.filter((a: any) => a.title?.includes("std.collection"))
			expect(importActions.length).toBe(0)
		})

		it("does not create import for unknown symbol", () => {
			const doc = makeDoc(["UnknownSymbol"])
			const diag = makeDiagnostic(0, "cannot find `UnknownSymbol`")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			expect(result.length).toBe(0)
		})

		it("matches 'undeclared' keyword", () => {
			const doc = makeDoc(["ArrayList"])
			const diag = makeDiagnostic(0, "undeclared identifier 'ArrayList'")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const importActions = result.filter((a: any) => a.title?.includes("std.collection"))
			expect(importActions.length).toBe(1)
		})

		it("matches quoted symbol in diagnostic", () => {
			const doc = makeDoc(["HashMap"])
			const diag = makeDiagnostic(0, "not found: `HashMap`")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const importActions = result.filter((a: any) => a.title?.includes("std.collection"))
			expect(importActions.length).toBe(1)
		})
	})

	describe("immutable → let to var", () => {
		it("creates let-to-var action when let declaration found", () => {
			const doc = makeDoc(["let x = 1", "x = 2"])
			const diag = makeDiagnostic(1, "cannot assign to immutable variable `x`")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const varActions = result.filter((a: any) => a.title?.includes("var"))
			expect(varActions.length).toBeGreaterThan(0)
		})

		it("matches '不可变' Chinese pattern", () => {
			const doc = makeDoc(["let x = 1", "x = 2"])
			const diag = makeDiagnostic(1, "不可变变量 x 不能赋值")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const varActions = result.filter((a: any) => a.title?.includes("var"))
			expect(varActions.length).toBeGreaterThan(0)
		})
	})

	describe("non-exhaustive → add wildcard case", () => {
		it("creates wildcard case action", () => {
			const doc = makeDoc(["match x {", "  case 1 =>()", "  case 2 =>()", "}"])
			const diag = makeDiagnostic(0, "non-exhaustive match")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const wildcardActions = result.filter(
				(a: any) => a.title?.includes("case") || a.title?.includes("wildcard"),
			)
			expect(wildcardActions.length).toBeGreaterThan(0)
		})

		it("matches Chinese '未穷尽' pattern", () => {
			const doc = makeDoc(["match x {", "  case 1 =>()", "}"])
			const diag = makeDiagnostic(0, "未穷尽 match")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const wildcardActions = result.filter(
				(a: any) => a.title?.includes("case") || a.title?.includes("wildcard"),
			)
			expect(wildcardActions.length).toBeGreaterThan(0)
		})
	})

	describe("missing return → add return", () => {
		it("creates return action for Int64 function", () => {
			const doc = makeDoc(["func foo(): Int64 {", "  if true {", "    return 1", "  }", "}"])
			const diag = makeDiagnostic(0, "missing return value")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const returnActions = result.filter((a: any) => a.title?.includes("return"))
			expect(returnActions.length).toBeGreaterThan(0)
		})

		it("matches 'return expected' pattern", () => {
			const doc = makeDoc(["func foo(): Int64 {", "}"])
			const diag = makeDiagnostic(0, "return expected")
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const returnActions = result.filter((a: any) => a.title?.includes("return"))
			expect(returnActions.length).toBeGreaterThan(0)
		})
	})

	describe("inferReturnValue type inference", () => {
		function getReturnValue(diagMessage: string, lines: string[]): string | undefined {
			const doc = makeDoc(lines)
			const diag = makeDiagnostic(0, diagMessage)
			const result = provider.provideCodeActions(doc, diag.range, { diagnostics: [diag] } as any, {} as any)
			const returnAction = result.find((a: any) => a.title?.includes("return"))
			if (!returnAction) return undefined
			const edit = (returnAction as any).edit
			if (!edit) return undefined
			const edits = edit.getEdits()
			if (!edits || edits.length === 0) return undefined
			return edits[0]?.text ?? undefined
		}

		it("infers 0 for Int64", () => {
			const text = getReturnValue("missing return", ["func foo(): Int64 {", "}"])
			expect(text).toContain("0")
		})

		it("infers 0.0 for Float64", () => {
			const text = getReturnValue("missing return", ["func foo(): Float64 {", "}"])
			expect(text).toContain("0.0")
		})

		it('infers "" for String', () => {
			const text = getReturnValue("missing return", ["func foo(): String {", "}"])
			expect(text).toContain('""')
		})

		it("infers false for Bool", () => {
			const text = getReturnValue("missing return", ["func foo(): Bool {", "}"])
			expect(text).toContain("false")
		})

		it("infers 0 for Option<Int64> (int64 check takes precedence)", () => {
			const text = getReturnValue("missing return", ["func foo(): Option<Int64> {", "}"])
			expect(text).toContain("0")
		})

		it("infers None for bare Option type", () => {
			const text = getReturnValue("missing return", ["func foo(): Option {", "}"])
			expect(text).toContain("None")
		})
	})

	describe("multiple diagnostics", () => {
		it("processes multiple diagnostics independently", () => {
			const doc = makeDoc(["let x = 1", "let y = 2", "x = 3", "y = 4"])
			const diag1 = makeDiagnostic(2, "cannot assign to immutable variable `x`")
			const diag2 = makeDiagnostic(3, "cannot assign to immutable variable `y`")
			const result = provider.provideCodeActions(
				doc,
				diag1.range,
				{ diagnostics: [diag1, diag2] } as any,
				{} as any,
			)
			expect(result.length).toBeGreaterThanOrEqual(2)
		})
	})
})
