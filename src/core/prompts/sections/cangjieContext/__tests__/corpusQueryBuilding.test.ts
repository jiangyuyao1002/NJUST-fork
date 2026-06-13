import { describe, it, expect, vi } from "vitest"
import * as vscode from "vscode"

vi.mock("../../CangjieErrorAnalyzer", () => ({
	resolveCjcPatternForDiagnostic: vi.fn(),
}))

const { importPathToCorpusQuery, buildAutoCorpusQueries, diagnosticToCorpusQuery } = await import(
	"../corpusQueryBuilding"
)
const { resolveCjcPatternForDiagnostic } = await import("../../CangjieErrorAnalyzer")

function makeDiagnostic(message: string, overrides: Partial<vscode.Diagnostic> = {}): vscode.Diagnostic {
	return {
		message,
		range: new vscode.Range(0, 0, 0, 10),
		severity: vscode.DiagnosticSeverity.Error,
		...overrides,
	} as vscode.Diagnostic
}

describe("importPathToCorpusQuery", () => {
	it("returns null for empty string", () => {
		expect(importPathToCorpusQuery("")).toBeNull()
	})

	it("returns null for star-only import", () => {
		expect(importPathToCorpusQuery("*")).toBeNull()
	})

	it("returns single part for one-segment import", () => {
		expect(importPathToCorpusQuery("stdio")).toBe("stdio")
	})

	it("returns last two parts for multi-segment import", () => {
		expect(importPathToCorpusQuery("std.collection.ArrayList")).toBe("collection ArrayList")
	})

	it("returns package + type for two-segment import", () => {
		expect(importPathToCorpusQuery("std.io.File")).toBe("io File")
	})

	it("filters out star segments", () => {
		expect(importPathToCorpusQuery("a.*.c")).toBe("a c")
	})

	it("handles deep import paths", () => {
		expect(importPathToCorpusQuery("a.b.c.d.e.f.g")).toBe("f g")
	})
})

describe("diagnosticToCorpusQuery", () => {
	it("returns null for empty message", () => {
		expect(diagnosticToCorpusQuery(makeDiagnostic(""))).toBeNull()
	})

	it("uses CJC pattern when resolved", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue({ category: "E0001" })
		expect(diagnosticToCorpusQuery(makeDiagnostic("E0001: type mismatch expected Int64 got String"))).toContain(
			"E0001",
		)
	})

	it("falls back to keyword heuristic when no CJC pattern", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue(null)
		const result = diagnosticToCorpusQuery(makeDiagnostic("error: variable identifier not found"))
		expect(result).toContain("variable")
		expect(result).toContain("identifier")
	})

	it("filters short words (length <= 2) from fallback", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue(null)
		const result = diagnosticToCorpusQuery(makeDiagnostic("error at line 42: a b cd"))
		expect(result).toContain("line")
		expect(result).not.toContain("cd")
	})

	it("strips error/warning prefix", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue(null)
		const result = diagnosticToCorpusQuery(makeDiagnostic("Error[42]: something went wrong here today"))
		expect(result).toContain("something")
		expect(result).not.toContain("Error")
	})

	it("truncates long CJC pattern results", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue({ category: "E9999" })
		const longMsg = "E9999: " + "x".repeat(200)
		const result = diagnosticToCorpusQuery(makeDiagnostic(longMsg))
		expect(result!.length).toBeLessThanOrEqual(121)
	})

	it("returns null for whitespace-only message", () => {
		expect(diagnosticToCorpusQuery(makeDiagnostic("   "))).toBeNull()
	})
})

describe("buildAutoCorpusQueries", () => {
	it("returns empty array for no imports or diagnostics", () => {
		expect(buildAutoCorpusQueries([], [])).toEqual([])
	})

	it("generates std import queries grouped by family", () => {
		const result = buildAutoCorpusQueries(["std.collection.ArrayList", "std.collection.HashMap"], [])
		expect(result.length).toBeGreaterThan(0)
		expect(result[0]).toContain("collection")
	})

	it("generates diagnostic queries", () => {
		vi.mocked(resolveCjcPatternForDiagnostic).mockReturnValue(null)
		const diags = [makeDiagnostic("error: type mismatch in expression")]
		const result = buildAutoCorpusQueries([], diags)
		expect(result.length).toBeGreaterThan(0)
		expect(result.some((q) => q.includes("type") || q.includes("mismatch"))).toBe(true)
	})

	it("caps at AUTO_CORPUS_QUERY_MAX (5)", () => {
		const result = buildAutoCorpusQueries(
			["std.a.X", "std.b.Y", "std.c.Z", "std.d.W", "std.e.V", "std.f.U", "local1", "local2"],
			[],
		)
		expect(result.length).toBeLessThanOrEqual(5)
	})

	it("separates std and local imports", () => {
		const result = buildAutoCorpusQueries(["std.io.File", "mypackage.MyType"], [])
		expect(result.length).toBeGreaterThanOrEqual(1)
		expect(result.some((q) => q.includes("io") || q.includes("File"))).toBe(true)
	})
})
