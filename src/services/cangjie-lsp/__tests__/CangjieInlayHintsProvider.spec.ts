import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("vscode", () => ({
	InlayHintKind: { Type: 1 },
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
}))

import { CangjieInlayHintsProvider } from "../CangjieInlayHintsProvider"

describe("CangjieInlayHintsProvider", () => {
	let provider: CangjieInlayHintsProvider

	beforeEach(() => {
		vi.clearAllMocks()
		provider = new CangjieInlayHintsProvider()
	})

	it("returns empty hints for empty document", async () => {
		const doc = { getText: () => "", lineAt: () => ({ text: "" }) } as any
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: false } as any)
		expect(result).toEqual([])
	})

	it("returns empty hints on cancellation", async () => {
		const doc = { getText: () => "" } as any
		const result = await provider.provideInlayHints(doc, {} as any, { isCancellationRequested: true } as any)
		expect(result).toEqual([])
	})
})
