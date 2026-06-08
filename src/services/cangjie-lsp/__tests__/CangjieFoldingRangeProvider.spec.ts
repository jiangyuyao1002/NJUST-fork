import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("vscode", () => ({
	FoldingRange: class {
		constructor(
			public start: number,
			public end: number,
			public kind?: number,
		) {}
	},
	FoldingRangeKind: { Region: 0, Comment: 1, Imports: 3 },
}))

import { CangjieFoldingRangeProvider } from "../CangjieFoldingRangeProvider"

describe("CangjieFoldingRangeProvider", () => {
	let provider: CangjieFoldingRangeProvider

	beforeEach(() => {
		provider = new CangjieFoldingRangeProvider()
	})

	it("returns empty for empty document", () => {
		const doc = {
			getText: () => "",
			lineCount: 0,
			lineAt: () => ({ text: "" }),
		} as any
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		expect(result).toEqual([])
	})

	it("returns empty for document without blocks", () => {
		const doc = {
			getText: () => "// comment\nlet x = 1",
			lineCount: 2,
			lineAt: (i: number) => ({ text: ["// comment", "let x = 1"][i] ?? "" }),
		} as any
		const result = provider.provideFoldingRanges(doc, {} as any, {} as any)
		expect(result).toEqual([])
	})
})
