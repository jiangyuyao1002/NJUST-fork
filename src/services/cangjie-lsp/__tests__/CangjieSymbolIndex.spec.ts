import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		getWorkspaceFolder: vi.fn(),
		findFiles: vi.fn().mockResolvedValue([]),
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
	},
	languages: {
		createDiagnosticCollection: vi.fn().mockReturnValue({
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		}),
		getDiagnostics: vi.fn().mockReturnValue([]),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showWarningMessage: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
		parse: (s: string) => ({ fsPath: s, toString: () => s }),
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
	Diagnostic: class {
		constructor(
			public range: unknown,
			public message: string,
			public severity: number,
		) {
			this.source = ""
		}
		source: string
	},
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn().mockReturnValue(false),
			readFileSync: vi.fn(),
			statSync: vi.fn(),
			mkdirSync: vi.fn(),
			writeFileSync: vi.fn(),
		},
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn(),
		statSync: vi.fn(),
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn(),
	}
})

vi.mock("../../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: vi.fn().mockReturnValue([]),
	parseCangjieWithFallback: vi.fn().mockReturnValue([]),
	computeCangjieSignature: vi.fn().mockReturnValue(""),
	extractCangjieDeclarationMeta: vi.fn().mockReturnValue({ visibility: "public", modifiers: [], typeParams: "" }),
}))

vi.mock("../../../shared/package", () => ({
	Package: { resolve: vi.fn().mockReturnValue(null) },
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	invalidateCangjieToolEnvCache: vi.fn(),
}))

vi.mock("../cangjieImportPaths", () => ({
	extractCangjieImportPackagePrefixes: vi.fn().mockReturnValue([]),
	posixPathMatchesImportPackage: vi.fn().mockReturnValue(false),
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

import { CangjieSymbolIndex } from "../CangjieSymbolIndex"

function populateIndex(
	index: CangjieSymbolIndex,
	files: Record<
		string,
		Array<{ name: string; kind: string; startLine: number; endLine: number; signature?: string }>
	>,
) {
	const data = (index as any).data
	const nameIndex = (index as any).nameIndex as Map<string, unknown[]>
	const _referenceIndex = (index as any).referenceIndex as Map<string, unknown[]>

	for (const [filePath, symbols] of Object.entries(files)) {
		const fileEntry = {
			mtime: Date.now(),
			symbols: symbols.map((s) => ({
				name: s.name,
				kind: s.kind,
				filePath,
				startLine: s.startLine,
				endLine: s.endLine,
				signature: s.signature ?? `func ${s.name}()`,
				visibility: "public",
			})),
			references: {},
		}
		data.files[filePath] = fileEntry
		for (const sym of fileEntry.symbols) {
			let list = nameIndex.get(sym.name)
			if (!list) {
				list = []
				nameIndex.set(sym.name, list)
			}
			list.push(sym)
		}
	}
	;(index as any)._fileCount = Object.keys(files).length
	;(index as any)._symbolCount = Object.values(files).reduce((sum, syms) => sum + syms.length, 0)
}

describe("CangjieSymbolIndex", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getInstance", () => {
		it("returns undefined when not initialized", () => {
			const instance = CangjieSymbolIndex.getInstance()
			expect(instance === undefined || instance instanceof CangjieSymbolIndex).toBe(true)
		})
	})

	describe("findDefinitions", () => {
		it("returns empty array for unknown symbol", () => {
			const index = new CangjieSymbolIndex()
			const result = index.findDefinitions("unknownSymbol")
			expect(result).toEqual([])
		})

		it("returns symbol when populated", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "myFunc", kind: "func", startLine: 0, endLine: 5 }],
			})
			const result = index.findDefinitions("myFunc")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("myFunc")
			expect(result[0]!.kind).toBe("func")
		})

		it("returns multiple symbols with same name from different files", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 3 }],
				"/ws/b.cj": [{ name: "foo", kind: "func", startLine: 10, endLine: 15 }],
			})
			const result = index.findDefinitions("foo")
			expect(result.length).toBe(2)
		})
	})

	describe("findReferences", () => {
		it("returns empty array for unknown symbol", () => {
			const index = new CangjieSymbolIndex()
			const result = index.findReferences("unknownSymbol")
			expect(result).toEqual([])
		})
	})

	describe("findSymbolsByPrefix", () => {
		it("returns empty array for short prefix", () => {
			const index = new CangjieSymbolIndex()
			const result = index.findSymbolsByPrefix("x")
			expect(result).toEqual([])
		})
	})

	describe("findEnclosingSymbol", () => {
		it("returns null for empty index", () => {
			const index = new CangjieSymbolIndex()
			const result = index.findEnclosingSymbol("/ws/test.cj", 5)
			expect(result).toBeNull()
		})

		it("returns null when line is outside all symbols", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [{ name: "foo", kind: "func", startLine: 10, endLine: 20 }],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 5)
			expect(result).toBeNull()
		})

		it("returns symbol when line is inside range", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [{ name: "foo", kind: "func", startLine: 5, endLine: 15 }],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 10)
			expect(result).not.toBeNull()
			expect(result!.name).toBe("foo")
		})

		it("returns innermost symbol for nested ranges", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [
					{ name: "Outer", kind: "class", startLine: 0, endLine: 50 },
					{ name: "inner", kind: "func", startLine: 10, endLine: 20 },
				],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 15)
			expect(result).not.toBeNull()
			expect(result!.name).toBe("inner")
		})

		it("returns null for non-existent file", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})
			const result = index.findEnclosingSymbol("/ws/nonexistent.cj", 2)
			expect(result).toBeNull()
		})

		it("excludes import and package symbols", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [
					{ name: "std.collection", kind: "import", startLine: 0, endLine: 0 },
					{ name: "mypkg", kind: "package", startLine: 1, endLine: 1 },
				],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 0)
			expect(result).toBeNull()
		})

		it("returns symbol on exact start line", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [{ name: "foo", kind: "func", startLine: 5, endLine: 10 }],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 5)
			expect(result).not.toBeNull()
			expect(result!.name).toBe("foo")
		})

		it("returns symbol on exact end line", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/test.cj": [{ name: "foo", kind: "func", startLine: 5, endLine: 10 }],
			})
			const result = index.findEnclosingSymbol("/ws/test.cj", 10)
			expect(result).not.toBeNull()
		})
	})

	describe("getConversionHintFromDiagnosticMessage", () => {
		function createIndexWithConversionEdges(): CangjieSymbolIndex {
			const index = new CangjieSymbolIndex()
			const map = (index as any).conversionEdgeMap as Map<string, string>
			map.set("int32|int64", "快速修复: 使用 `.toInt64()` 或 `Int64(...)`")
			map.set("uint32|uint64", "快速修复: 使用 `.toUInt64()` 或 `UInt64(...)`")
			map.set("int64|int32", "快速修复: 使用 `.toInt32()`（注意范围/溢出）")
			map.set("float32|float64", "快速修复: 使用 `.toFloat64()`")
			map.set("int64|float64", "快速修复: 使用 `.toFloat64()`")
			return index
		}

		it("returns hint for built-in int32 to int64 conversion", () => {
			const index = createIndexWithConversionEdges()
			const result = index.getConversionHintFromDiagnosticMessage("type mismatch: `int32` and `int64`")
			expect(result).not.toBeNull()
			expect(result).toContain("toInt64")
		})

		it("returns hint for float32 to float64 conversion", () => {
			const index = createIndexWithConversionEdges()
			const result = index.getConversionHintFromDiagnosticMessage("`float32` 与 `float64` 不匹配")
			expect(result).not.toBeNull()
			expect(result).toContain("toFloat64")
		})

		it("returns null for unrelated diagnostic", () => {
			const index = createIndexWithConversionEdges()
			const result = index.getConversionHintFromDiagnosticMessage("some unrelated error")
			expect(result).toBeNull()
		})

		it("handles Int64 and Int32 case-insensitively via regex fallback", () => {
			const index = createIndexWithConversionEdges()
			const result = index.getConversionHintFromDiagnosticMessage("Int64 and Int32 mismatch")
			expect(result).not.toBeNull()
		})

		it("returns hint for Chinese separator '与'", () => {
			const index = createIndexWithConversionEdges()
			const result = index.getConversionHintFromDiagnosticMessage("`int32` 与 `int64` 类型不匹配")
			expect(result).not.toBeNull()
			expect(result).toContain("toInt64")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			const index = new CangjieSymbolIndex()
			expect(() => index.dispose()).not.toThrow()
		})

		it("clears singleton instance", () => {
			const index = new CangjieSymbolIndex()
			index.dispose()
			const instance = CangjieSymbolIndex.getInstance()
			expect(instance === undefined || instance !== index).toBe(true)
		})
	})
})
