import { describe, it, expect, vi } from "vitest"

vi.mock("../cangjie-context", () => ({
	getCangjiePromptServices: vi.fn(() => ({
		getCangjieSymbolIndex: vi.fn(() => null),
	})),
}))
vi.mock("../CangjieErrorAnalyzer", () => ({
	normalizeDiagnosticCode: vi.fn(() => null),
	resolveCjcPatternForDiagnostic: vi.fn(() => null),
	buildDiagnosticPatternCache: vi.fn(() => new Map()),
}))
vi.mock("../CangjieSymbolExtractor", () => ({
	getActiveCangjieFileInfo: vi.fn(() => null),
}))
vi.mock("./budget", () => ({
	simpleHash: vi.fn(() => 0),
}))

const {
	diagnosticTypeFingerprint,
	normalizeDiagnosticMessageForAggregation,
	buildConversionHintByMessage,
	mapDiagnosticsToDocContext,
} = await import("../diagnosticHandling")

describe("diagnosticTypeFingerprint", () => {
	it("extracts backtick identifiers", () => {
		expect(diagnosticTypeFingerprint("use of undeclared type `MyType` in expression")).toBe("mytype")
	})

	it("extracts multiple backtick identifiers, max 4", () => {
		expect(diagnosticTypeFingerprint("`Foo` expects `Bar` but got `Baz` or `Qux` or `Quux`")).toBe(
			"foo|bar|baz|qux",
		)
	})

	it("falls back to primitive types when no backticks", () => {
		expect(diagnosticTypeFingerprint("type mismatch: expected Int64, got Float32")).toBe("int64|float32")
	})

	it("deduplicates primitive types", () => {
		expect(diagnosticTypeFingerprint("Int64 vs Int64 comparison")).toBe("int64")
	})

	it("returns empty string for unmatched messages", () => {
		expect(diagnosticTypeFingerprint("some general error message without identifiers")).toBe("")
	})

	it("removes spaces from backtick identifiers", () => {
		expect(diagnosticTypeFingerprint("type `My Type` not found")).toBe("mytype")
	})

	it("handles mixed Bool and String primitives", () => {
		expect(diagnosticTypeFingerprint("cannot assign Bool value to String variable")).toBe("bool|string")
	})
})

describe("normalizeDiagnosticMessageForAggregation", () => {
	it("normalizes whitespace", () => {
		expect(normalizeDiagnosticMessageForAggregation("hello   world")).toBe("hello world")
	})

	it("removes Windows-style paths", () => {
		const result = normalizeDiagnosticMessageForAggregation("error in C:/path/to/file.cj:42")
		expect(result).not.toContain("C:/")
	})

	it("removes bracket prefixes", () => {
		const result = normalizeDiagnosticMessageForAggregation("[E0001] type mismatch")
		expect(result).not.toContain("[E0001]")
		expect(result).toContain("type mismatch")
	})

	it("preserves fingerprint suffix when backticks present", () => {
		const result = normalizeDiagnosticMessageForAggregation("error: unknown type `Foo` in scope")
		expect(result).toContain("foo")
	})

	it("preserves fingerprint suffix when primitives present", () => {
		const result = normalizeDiagnosticMessageForAggregation("expected Int64 got String")
		expect(result).toContain("int64")
	})

	it("trims message to 180 chars for base", () => {
		const longMsg = "x".repeat(300)
		const result = normalizeDiagnosticMessageForAggregation(longMsg)
		expect(result.length).toBeLessThanOrEqual(200) // 180 base + fingerprint
	})

	it("converts CRLF to LF", () => {
		const result = normalizeDiagnosticMessageForAggregation("line1\r\nline2")
		expect(result).not.toContain("\r")
	})
})

describe("buildConversionHintByMessage", () => {
	it("returns empty map when no symbol index", () => {
		const map = buildConversionHintByMessage([])
		expect(map.size).toBe(0)
	})

	it("returns empty map for empty diagnostics", () => {
		const map = buildConversionHintByMessage([])
		expect(map.size).toBe(0)
	})
})

describe("mapDiagnosticsToDocContext", () => {
	it("returns empty array for empty diagnostics", () => {
		const result = mapDiagnosticsToDocContext([], "/tmp/docs", new Map())
		expect(result).toEqual([])
	})
})
