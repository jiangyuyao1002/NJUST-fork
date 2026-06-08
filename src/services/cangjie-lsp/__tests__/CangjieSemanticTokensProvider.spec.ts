import { describe, it, expect, vi } from "vitest"

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("vscode", () => ({
	SemanticTokensLegend: class {
		constructor(
			public tokenTypes: string[],
			public tokenModifiers: string[],
		) {}
	},
	SemanticTokensBuilder: class {
		push() {}
		build() {
			return { data: new Uint32Array(0) }
		}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

import { CangjieSemanticTokensProvider } from "../CangjieSemanticTokensProvider"

describe("CangjieSemanticTokensProvider", () => {
	it("legend static getter returns legend instance", () => {
		const legend = CangjieSemanticTokensProvider.legend
		expect(legend).toBeDefined()
		expect(legend.tokenTypes).toContain("type")
		expect(legend.tokenTypes).toContain("function")
		expect(legend.tokenModifiers).toContain("declaration")
	})

	it("returns empty tokens for empty document", async () => {
		const provider = new CangjieSemanticTokensProvider()
		const doc = {
			getText: () => "",
			lineAt: () => ({ text: "" }),
		} as any
		const result = await provider.provideDocumentSemanticTokens(doc)
		expect(result.data).toBeDefined()
	})
})
