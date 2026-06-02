import { beforeEach, describe, expect, it, vi } from "vitest"

const fsMock = vi.hoisted(() => ({
	access: vi.fn(),
	readFile: vi.fn(),
}))

vi.mock("fs/promises", () => fsMock)

vi.mock("../../../../services/cangjie-lsp/CangjieErrorAnalyzer", () => ({
	STDLIB_DOC_MAP: [{ prefix: "std.collection", summary: "collections", docPaths: ["std/collection.md"] }],
	getErrorFixDirective: vi.fn(() => "fix the root cause"),
	getMatchingCjcPatternsByCategory: vi.fn((text: string) =>
		text.includes("missing_symbol")
			? [
					{
						category: "missing import",
						suggestion: "add import",
						fixDirective: "add the missing import",
						docPaths: ["std/collection.md"],
					},
				]
			: [],
	),
}))

vi.mock("../../../../services/cangjie-lsp/CangjieSymbolIndex", () => ({
	CangjieSymbolIndex: {
		getInstance: vi.fn(function () {
			return {
				findEnclosingSymbol: vi.fn(function () {
					return {
						kind: "func",
						name: "main",
						signature: "func main(): Int64",
					}
				}),
			}
		}),
	},
}))

vi.mock("../CangjieDocsResolver", () => ({
	resolveCangjieDocsBasePath: vi.fn(() => "C:/ext/corpus"),
}))

import { buildCangjieExecuteCommandErrorAppendix, enhanceCjcErrorOutput } from "../CangjiePromptErrorAnalysis"

describe("CangjiePromptErrorAnalysis", () => {
	beforeEach(() => {
		fsMock.access.mockReset()
		fsMock.readFile.mockReset()
		fsMock.access.mockResolvedValue(undefined)
		fsMock.readFile.mockResolvedValue("package demo\nimport std.collection.*\nmain(): Int64 {\n\treturn 0\n}\n")
	})

	it("adds source context and matched suggestions for cjc output", async () => {
		const output = "==> src/main.cj:3:1:\nmissing_symbol"

		const appendix = await enhanceCjcErrorOutput(output, "C:/workspace", "C:/ext")

		expect(appendix).toContain("<cangjie_error_hints>")
		expect(appendix).toContain("src/main.cj")
		expect(appendix).toContain("missing import")
		expect(fsMock.readFile).toHaveBeenCalledWith(expect.stringContaining("main.cj"), "utf-8")
	})

	it("returns an empty appendix when no source context or known pattern is available", async () => {
		fsMock.access.mockRejectedValue(new Error("missing"))

		await expect(enhanceCjcErrorOutput("plain output", "C:/workspace")).resolves.toBe("")
	})

	it("builds per-location execute_command appendix", async () => {
		const output = "==> src/main.cj:3:1:\nmissing_symbol"

		const appendix = await buildCangjieExecuteCommandErrorAppendix(output, "C:/workspace", "C:/ext")

		expect(appendix).toContain("<cangjie_error_hints>")
		expect(appendix).toContain("missing_symbol")
		expect(appendix).toContain("add import")
	})
})
