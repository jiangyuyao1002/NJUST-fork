import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	Range: class {
		constructor(
			public start: { line: number; character: number },
			public end: { line: number; character: number },
		) {}
	},
	CodeLens: class {
		constructor(
			public range: unknown,
			public command: unknown,
		) {}
	},
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieTestCodeLensProvider } from "../CangjieTestCodeLensProvider"

function makeDocument(lines: string[]) {
	return {
		lineCount: lines.length,
		lineAt: (i: number) => ({ text: lines[i] ?? "" }),
	} as any
}

describe("CangjieTestCodeLensProvider", () => {
	let provider: CangjieTestCodeLensProvider

	beforeEach(() => {
		provider = new CangjieTestCodeLensProvider()
	})

	it("returns empty for empty document", () => {
		const lenses = provider.provideCodeLenses(makeDocument([]), {} as any)
		expect(lenses).toEqual([])
	})

	it("returns empty for file without @Test annotations", () => {
		const lenses = provider.provideCodeLenses(makeDocument(["class Foo {", "  func bar() {}", "}"]), {} as any)
		expect(lenses).toEqual([])
	})

	it("generates CodeLens for @Test class", () => {
		const lenses = provider.provideCodeLenses(makeDocument(["@Test", "class MyTest {", "}"]), {} as any)
		expect(lenses.length).toBe(2) // Run + Debug
	})

	it("generates CodeLens for @TestCase func", () => {
		const lenses = provider.provideCodeLenses(makeDocument(["@TestCase", "func testFoo() {}", ""]), {} as any)
		expect(lenses.length).toBe(2) // Run + Debug
	})

	it("does not generate CodeLens for @Test without following class/func", () => {
		const lenses = provider.provideCodeLenses(makeDocument(["@Test", "// comment", ""]), {} as any)
		expect(lenses).toEqual([])
	})

	it("handles multiple @TestCase functions", () => {
		const lenses = provider.provideCodeLenses(
			makeDocument(["@TestCase", "func testA() {}", "@TestCase", "func testB() {}", ""]),
			{} as any,
		)
		expect(lenses.length).toBe(4) // 2 funcs × 2 lenses each
	})
})
