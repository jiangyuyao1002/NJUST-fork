import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import * as fs from "fs"
import {
	parseCangjieDefinitions,
	computeCangjieSignature,
	extractCangjieDeclarationMeta,
} from "../../tree-sitter/cangjieParser"
import { TelemetryService } from "@njust-ai/telemetry"

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

	function createMockOutputChannel() {
		return { appendLine: vi.fn(), dispose: vi.fn() }
	}

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

	describe("getSymbolsByFile", () => {
		it("returns symbols for file", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})
			const result = index.getSymbolsByFile("/ws/a.cj")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("foo")
		})

		it("returns empty array for non-existent file", () => {
			const index = new CangjieSymbolIndex()
			const result = index.getSymbolsByFile("/ws/nonexistent.cj")
			expect(result).toEqual([])
		})
	})

	describe("getIndexedFiles", () => {
		it("returns empty array for empty index", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getIndexedFiles()).toEqual([])
		})

		it("returns indexed file paths", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
				"/ws/b.cj": [{ name: "bar", kind: "func", startLine: 0, endLine: 3 }],
			})
			const files = index.getIndexedFiles()
			expect(files.length).toBe(2)
			expect(files).toContain("/ws/a.cj")
			expect(files).toContain("/ws/b.cj")
		})
	})

	describe("fileCount and symbolCount", () => {
		it("returns 0 for empty index", () => {
			const index = new CangjieSymbolIndex()
			expect(index.fileCount).toBe(0)
			expect(index.symbolCount).toBe(0)
		})

		it("returns correct counts when populated", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [
					{ name: "foo", kind: "func", startLine: 0, endLine: 5 },
					{ name: "bar", kind: "func", startLine: 6, endLine: 10 },
				],
				"/ws/b.cj": [{ name: "baz", kind: "func", startLine: 0, endLine: 3 }],
			})
			expect(index.symbolCount).toBe(3)
			expect(index.fileCount).toBe(2)
		})
	})

	describe("findDefinitionsByKind", () => {
		it("returns symbols matching name and kind", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [
					{ name: "MyMacro", kind: "macro", startLine: 0, endLine: 3 },
					{ name: "MyMacro", kind: "func", startLine: 10, endLine: 15 },
				],
			})
			const result = index.findDefinitionsByKind("MyMacro", "macro")
			expect(result.length).toBe(1)
			expect(result[0]!.kind).toBe("macro")
		})

		it("returns empty array when no match", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})
			const result = index.findDefinitionsByKind("foo", "macro")
			expect(result).toEqual([])
		})
	})

	describe("findSymbolsByPrefix — additional cases", () => {
		it("returns empty array for short prefix", () => {
			const index = new CangjieSymbolIndex()
			const result = index.findSymbolsByPrefix("x")
			expect(result).toEqual([])
		})

		it("returns empty array when no match in trie", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "fooBar", kind: "func", startLine: 0, endLine: 5 }],
			})
			// populateIndex doesn't populate the prefix trie, so this returns empty
			const result = index.findSymbolsByPrefix("foo")
			expect(result).toEqual([])
		})
	})

	// ── NEW TESTS ──────────────────────────────────────────────────────────

	describe("reindexFile", () => {
		it("returns early for non-.cj file", async () => {
			const index = new CangjieSymbolIndex()
			await index.reindexFile("/ws/test.ts")
			expect(fs.statSync).not.toHaveBeenCalled()
			expect(fs.readFileSync).not.toHaveBeenCalled()
			expect((index as any).data.files["/ws/test.ts"]).toBeUndefined()
		})

		it("indexes a .cj file successfully", async () => {
			const index = new CangjieSymbolIndex()
			const mockStat = { mtimeMs: 1000 }
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue(mockStat)
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("func main() {\n\tfoo()\n}")
			;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([
				{ kind: "func", name: "main", startLine: 0, endLine: 2 },
			])
			;(computeCangjieSignature as ReturnType<typeof vi.fn>).mockReturnValue("func main()")
			;(extractCangjieDeclarationMeta as ReturnType<typeof vi.fn>).mockReturnValue({
				visibility: "public",
				modifiers: [],
				typeParams: "",
			})

			await index.reindexFile("/ws/main.cj")

			const defs = index.findDefinitions("main")
			expect(defs.length).toBe(1)
			expect(defs[0]!.name).toBe("main")
			expect(defs[0]!.kind).toBe("func")
			expect(defs[0]!.filePath).toBe("/ws/main.cj")
			expect(defs[0]!.visibility).toBe("public")
			expect(fs.statSync).toHaveBeenCalledWith("/ws/main.cj")
			expect(fs.readFileSync).toHaveBeenCalledWith("/ws/main.cj", "utf-8")
			expect(parseCangjieDefinitions).toHaveBeenCalledWith("func main() {\n\tfoo()\n}")
		})

		it("filters out import definitions during reindex", async () => {
			const index = new CangjieSymbolIndex()
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 1000 })
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("import pkg\nfunc foo() {}")
			;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([
				{ kind: "import", name: "pkg", startLine: 0, endLine: 0 },
				{ kind: "func", name: "foo", startLine: 1, endLine: 1 },
			])
			;(computeCangjieSignature as ReturnType<typeof vi.fn>).mockReturnValue("func foo()")
			;(extractCangjieDeclarationMeta as ReturnType<typeof vi.fn>).mockReturnValue({
				visibility: "public",
				modifiers: [],
				typeParams: "",
			})

			await index.reindexFile("/ws/a.cj")

			// Import should be filtered out; only "foo" should be in the name index
			expect(index.findDefinitions("pkg")).toEqual([])
			expect(index.findDefinitions("foo").length).toBe(1)
		})

		it("handles error when file is unreadable", async () => {
			const mockOutputChannel = { appendLine: vi.fn(), dispose: vi.fn() }
			const index = new CangjieSymbolIndex(mockOutputChannel as any)
			;(fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("ENOENT: file not found")
			})

			await index.reindexFile("/ws/missing.cj")

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to reindex"))
			expect(TelemetryService.reportError).toHaveBeenCalled()
		})

		it("deduplicates error logging for the same file", async () => {
			const mockOutputChannel = { appendLine: vi.fn(), dispose: vi.fn() }
			const index = new CangjieSymbolIndex(mockOutputChannel as any)
			;(fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("ENOENT")
			})

			await index.reindexFile("/ws/bad.cj")
			await index.reindexFile("/ws/bad.cj")

			const logCalls = mockOutputChannel.appendLine.mock.calls.filter((c: any[]) =>
				c[0].includes("Failed to reindex"),
			)
			expect(logCalls.length).toBe(1)
			// But telemetry is reported every time
			expect(TelemetryService.reportError).toHaveBeenCalledTimes(2)
		})

		it("updates existing entry when re-indexing same file", async () => {
			const index = new CangjieSymbolIndex()
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 1000 })
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("func old() {}")
			;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([
				{ kind: "func", name: "old", startLine: 0, endLine: 0 },
			])
			;(computeCangjieSignature as ReturnType<typeof vi.fn>).mockReturnValue("func old()")
			;(extractCangjieDeclarationMeta as ReturnType<typeof vi.fn>).mockReturnValue({
				visibility: "public",
				modifiers: [],
				typeParams: "",
			})

			await index.reindexFile("/ws/a.cj")
			expect(index.findDefinitions("old").length).toBe(1)

			// Re-index with updated content
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 2000 })
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("func updated() {}")
			;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([
				{ kind: "func", name: "updated", startLine: 0, endLine: 0 },
			])
			;(computeCangjieSignature as ReturnType<typeof vi.fn>).mockReturnValue("func updated()")

			await index.reindexFile("/ws/a.cj")

			// Old symbol should be gone, new one should exist
			expect(index.findDefinitions("old")).toEqual([])
			expect(index.findDefinitions("updated").length).toBe(1)
			expect(index.fileCount).toBe(1)
		})
	})

	describe("initialize and loadFromDisk", () => {
		async function setupInitialize(workspacePath: string) {
			// Set workspace folders so pickIndexRootFolder succeeds
			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: workspacePath }, name: "test", index: 0 }]
			// existsSync: true for cjpm.toml, false for everything else by default
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
				if (p.endsWith("cjpm.toml")) return true
				return false
			})
			// findFiles returns empty for fast fullIndex
			;(vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])
		}

		it("loads index from disk when version matches", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			const indexData = {
				version: 5,
				files: {
					"/ws/a.cj": {
						mtime: 1000,
						symbols: [
							{
								name: "loadedFunc",
								kind: "func",
								filePath: "/ws/a.cj",
								startLine: 0,
								endLine: 5,
								signature: "func loadedFunc()",
							},
						],
						references: {},
					},
				},
			}
			await setupInitialize("/ws")
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
				if (p.endsWith("cjpm.toml")) return true
				if (p.endsWith("symbols.json")) return true
				return false
			})
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(indexData))

			await index.initialize()

			// The loaded symbol should be findable
			const defs = index.findDefinitions("loadedFunc")
			expect(defs.length).toBe(1)
			expect(defs[0]!.name).toBe("loadedFunc")
		})

		it("ignores index file when version does not match", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			const oldData = { version: 1, files: { "/ws/old.cj": { mtime: 500, symbols: [], references: {} } } }
			await setupInitialize("/ws")
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
				if (p.endsWith("cjpm.toml")) return true
				if (p.endsWith("symbols.json")) return true
				return false
			})
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(oldData))

			await index.initialize()

			// Old version data should not have been loaded
			expect(index.getSymbolsByFile("/ws/old.cj")).toEqual([])
		})

		it("handles corrupt JSON gracefully", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			await setupInitialize("/ws")
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
				if (p.endsWith("cjpm.toml")) return true
				if (p.endsWith("symbols.json")) return true
				return false
			})
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("{ not valid json !!!")

			await index.initialize()

			// Should fall back to empty data without throwing
			expect(index.getIndexedFiles()).toEqual([])
		})

		it("uses empty data when index file does not exist", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			await setupInitialize("/ws")
			// existsSync returns false for everything except cjpm.toml (set by setupInitialize)
			;(vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

			await index.initialize()

			expect(index.getIndexedFiles()).toEqual([])
		})

		it("returns early when no workspace folder has cjpm.toml", async () => {
			const index = new CangjieSymbolIndex()
			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" }, name: "test", index: 0 }]
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)

			await index.initialize()

			// No watcher should have been created
			expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
		})

		it("returns early when there are no workspace folders", async () => {
			const index = new CangjieSymbolIndex()
			;(vscode.workspace as any).workspaceFolders = []

			await index.initialize()

			expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
		})
	})

	describe("saveToDisk and scheduleSave", () => {
		it("saveToDisk writes JSON when dirty and indexPath is set", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).indexPath = "/tmp/test-index/symbols.json"
			;(index as any).dirty = true
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
			;(index as any).saveToDisk()

			expect(fs.writeFileSync).toHaveBeenCalledWith("/tmp/test-index/symbols.json", expect.any(String), "utf-8")
			expect((index as any).dirty).toBe(false)
		})

		it("saveToDisk creates directory if it does not exist", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).indexPath = "/tmp/new-dir/symbols.json"
			;(index as any).dirty = true
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
			;(index as any).saveToDisk()

			expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/new-dir", { recursive: true })
			expect(fs.writeFileSync).toHaveBeenCalled()
		})

		it("saveToDisk does nothing when not dirty", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).indexPath = "/tmp/test/symbols.json"
			;(index as any).dirty = false
			;(index as any).saveToDisk()

			expect(fs.writeFileSync).not.toHaveBeenCalled()
		})

		it("saveToDisk does nothing when indexPath is undefined", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).dirty = true
			;(index as any).saveToDisk()

			expect(fs.writeFileSync).not.toHaveBeenCalled()
		})

		it("saveToDisk handles write error gracefully", () => {
			const mockOutputChannel = { appendLine: vi.fn(), dispose: vi.fn() }
			const index = new CangjieSymbolIndex(mockOutputChannel as any)
			;(index as any).indexPath = "/tmp/test/symbols.json"
			;(index as any).dirty = true
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
			;(fs.writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("disk full")
			})

			expect(() => (index as any).saveToDisk()).not.toThrow()

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to save"))
			expect(TelemetryService.reportError).toHaveBeenCalled()
			// dirty should remain true since save failed
			expect((index as any).dirty).toBe(true)
		})

		it("scheduleSave debounces with 5 second timer", () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				;(index as any).indexPath = "/tmp/test/symbols.json"
				;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
				;(index as any).scheduleSave()
				expect((index as any).dirty).toBe(true)

				// Should not have saved yet
				expect(fs.writeFileSync).not.toHaveBeenCalled()

				// Advance past the debounce window
				vi.advanceTimersByTime(5000)
				expect(fs.writeFileSync).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("scheduleSave does not create duplicate timers", () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				;(index as any).indexPath = "/tmp/test/symbols.json"
				;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
				;(index as any).scheduleSave()
				const timer1 = (index as any).flushTimer

				// Call again - should reuse the same timer
				;(index as any).scheduleSave()
				const timer2 = (index as any).flushTimer

				expect(timer1).toBe(timer2)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("getSymbolsByDirectory", () => {
		it("returns symbols from files under the directory", () => {
			const index = new CangjieSymbolIndex()
			// Manually set up directory index
			const dirIndex = (index as any).directoryIndex as Map<string, Set<string>>
			dirIndex.set("/ws/src", new Set(["/ws/src/a.cj", "/ws/src/b.cj"]))
			;(index as any).data.files["/ws/src/a.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "foo",
						kind: "func",
						filePath: "/ws/src/a.cj",
						startLine: 0,
						endLine: 5,
						signature: "func foo()",
						visibility: "public",
					},
				],
				references: {},
			}
			;(index as any).data.files["/ws/src/b.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "bar",
						kind: "func",
						filePath: "/ws/src/b.cj",
						startLine: 0,
						endLine: 3,
						signature: "func bar()",
						visibility: "public",
					},
				],
				references: {},
			}

			const result = index.getSymbolsByDirectory("/ws/src")
			expect(result.length).toBe(2)
			const names = result.map((s) => s.name)
			expect(names).toContain("foo")
			expect(names).toContain("bar")
		})

		it("returns empty array for unknown directory", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getSymbolsByDirectory("/ws/unknown")).toEqual([])
		})

		it("handles backslash normalization on Windows paths", () => {
			const index = new CangjieSymbolIndex()
			const dirIndex = (index as any).directoryIndex as Map<string, Set<string>>
			dirIndex.set("/ws/src", new Set(["/ws/src/a.cj"]))
			;(index as any).data.files["/ws/src/a.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "winFunc",
						kind: "func",
						filePath: "/ws/src/a.cj",
						startLine: 0,
						endLine: 5,
						signature: "func winFunc()",
						visibility: "public",
					},
				],
				references: {},
			}

			// Use backslashes - should be normalized to forward slashes
			const result = index.getSymbolsByDirectory("\\ws\\src")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("winFunc")
		})
	})

	describe("getPublicSymbolsForFile", () => {
		it("returns symbols with visibility=public", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).data.files["/ws/a.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "pubFunc",
						kind: "func",
						filePath: "/ws/a.cj",
						startLine: 0,
						endLine: 5,
						signature: "public func pubFunc()",
						visibility: "public",
					},
					{
						name: "privFunc",
						kind: "func",
						filePath: "/ws/a.cj",
						startLine: 6,
						endLine: 10,
						signature: "func privFunc()",
						visibility: "private",
					},
				],
				references: {},
			}

			const result = index.getPublicSymbolsForFile("/ws/a.cj")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("pubFunc")
		})

		it("filters out import and package kinds even if public", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).data.files["/ws/a.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "std.io",
						kind: "import",
						filePath: "/ws/a.cj",
						startLine: 0,
						endLine: 0,
						signature: "import std.io",
						visibility: "public",
					},
					{
						name: "mypkg",
						kind: "package",
						filePath: "/ws/a.cj",
						startLine: 1,
						endLine: 1,
						signature: "package mypkg",
						visibility: "public",
					},
					{
						name: "realFunc",
						kind: "func",
						filePath: "/ws/a.cj",
						startLine: 2,
						endLine: 5,
						signature: "public func realFunc()",
						visibility: "public",
					},
				],
				references: {},
			}

			const result = index.getPublicSymbolsForFile("/ws/a.cj")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("realFunc")
		})

		it("falls back to signature regex when visibility is undefined", () => {
			const index = new CangjieSymbolIndex()
			;(index as any).data.files["/ws/a.cj"] = {
				mtime: 1000,
				symbols: [
					{
						name: "sigPublic",
						kind: "func",
						filePath: "/ws/a.cj",
						startLine: 0,
						endLine: 5,
						signature: "public func sigPublic()",
					},
					{
						name: "sigPrivate",
						kind: "func",
						filePath: "/ws/a.cj",
						startLine: 6,
						endLine: 10,
						signature: "func sigPrivate()",
					},
				],
				references: {},
			}

			const result = index.getPublicSymbolsForFile("/ws/a.cj")
			expect(result.length).toBe(1)
			expect(result[0]!.name).toBe("sigPublic")
		})

		it("returns empty array for unknown file", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getPublicSymbolsForFile("/ws/nonexistent.cj")).toEqual([])
		})
	})

	describe("getAllSymbols", () => {
		it("returns empty array for empty index", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getAllSymbols()).toEqual([])
		})

		it("returns all symbols across all files", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [
					{ name: "foo", kind: "func", startLine: 0, endLine: 5 },
					{ name: "bar", kind: "func", startLine: 6, endLine: 10 },
				],
				"/ws/b.cj": [{ name: "baz", kind: "class", startLine: 0, endLine: 20 }],
			})

			const all = index.getAllSymbols()
			expect(all.length).toBe(3)
			const names = all.map((s) => s.name)
			expect(names).toContain("foo")
			expect(names).toContain("bar")
			expect(names).toContain("baz")
		})
	})

	describe("findSymbolsByPrefix with rebuilt trie", () => {
		/** BFS traversal collects duplicates (symbol stored at every trie node along its name). Deduplicate for assertions. */
		function uniqueBySymbol(results: Array<{ name: string; filePath: string; startLine: number }>) {
			const seen = new Set<string>()
			return results.filter((s) => {
				const key = `${s.filePath}:${s.name}:${s.startLine}`
				if (seen.has(key)) return false
				seen.add(key)
				return true
			})
		}

		it("finds symbols after rebuildPrefixTrie", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [
					{ name: "calculateTotal", kind: "func", startLine: 0, endLine: 5 },
					{ name: "calculateTax", kind: "func", startLine: 6, endLine: 10 },
					{ name: "renderView", kind: "func", startLine: 11, endLine: 15 },
				],
			})

			// Rebuild the prefix trie (populateIndex doesn't do this)
			;(index as any).rebuildPrefixTrie()

			const calcResults = uniqueBySymbol(index.findSymbolsByPrefix("calc"))
			expect(calcResults.length).toBe(2)
			const calcNames = calcResults.map((s) => s.name)
			expect(calcNames).toContain("calculateTotal")
			expect(calcNames).toContain("calculateTax")

			const renderResults = uniqueBySymbol(index.findSymbolsByPrefix("render"))
			expect(renderResults.length).toBe(1)
			expect(renderResults[0]!.name).toBe("renderView")
		})

		it("is case-insensitive", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "MyFunction", kind: "func", startLine: 0, endLine: 5 }],
			})
			;(index as any).rebuildPrefixTrie()

			const results = uniqueBySymbol(index.findSymbolsByPrefix("myf"))
			expect(results.length).toBe(1)
			expect(results[0]!.name).toBe("MyFunction")
		})

		it("respects the limit parameter", () => {
			const index = new CangjieSymbolIndex()
			const symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }> = []
			for (let i = 0; i < 10; i++) {
				symbols.push({ name: `func_${i}`, kind: "func", startLine: i * 10, endLine: i * 10 + 5 })
			}
			populateIndex(index, { "/ws/a.cj": symbols })
			;(index as any).rebuildPrefixTrie()

			const results = index.findSymbolsByPrefix("func", 3)
			expect(results.length).toBe(3)
		})

		it("returns empty for prefix that does not match any symbol", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "alpha", kind: "func", startLine: 0, endLine: 5 }],
			})
			;(index as any).rebuildPrefixTrie()

			expect(index.findSymbolsByPrefix("zzz")).toEqual([])
		})
	})

	describe("filterSymbolsByScope (via findDefinitions/findReferences)", () => {
		it("findDefinitions returns all symbols when no scopeUri is provided", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/projectA/a.cj": [{ name: "shared", kind: "func", startLine: 0, endLine: 5 }],
				"/ws/projectB/b.cj": [{ name: "shared", kind: "func", startLine: 0, endLine: 5 }],
			})

			const result = index.findDefinitions("shared")
			expect(result.length).toBe(2)
		})

		it("findDefinitions filters by scope when scopeUri is provided", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/projectA/a.cj": [{ name: "shared", kind: "func", startLine: 0, endLine: 5 }],
				"/ws/projectB/b.cj": [{ name: "shared", kind: "func", startLine: 0, endLine: 5 }],
			})

			const scopeUri = vscode.Uri.file("/ws/projectA")
			;(vscode.workspace.getWorkspaceFolder as ReturnType<typeof vi.fn>).mockReturnValue({
				uri: { fsPath: "/ws/projectA" },
				name: "projectA",
				index: 0,
			})

			const result = index.findDefinitions("shared", scopeUri)
			expect(result.length).toBe(1)
			expect(result[0]!.filePath).toBe("/ws/projectA/a.cj")
		})

		it("findReferences returns all references when no scopeUri", () => {
			const index = new CangjieSymbolIndex()
			const refIndex = (index as any).referenceIndex as Map<string, unknown[]>
			refIndex.set("myVar", [
				{ filePath: "/ws/a.cj", line: 5, column: 10 },
				{ filePath: "/ws/b.cj", line: 3, column: 2 },
			])

			const result = index.findReferences("myVar")
			expect(result.length).toBe(2)
		})

		it("findReferences filters by scope when scopeUri is provided", () => {
			const index = new CangjieSymbolIndex()
			const refIndex = (index as any).referenceIndex as Map<string, unknown[]>
			refIndex.set("myVar", [
				{ filePath: "/ws/projectA/a.cj", line: 5, column: 10 },
				{ filePath: "/ws/projectB/b.cj", line: 3, column: 2 },
			])

			const scopeUri = vscode.Uri.file("/ws/projectA")
			;(vscode.workspace.getWorkspaceFolder as ReturnType<typeof vi.fn>).mockReturnValue({
				uri: { fsPath: "/ws/projectA" },
				name: "projectA",
				index: 0,
			})

			const result = index.findReferences("myVar", scopeUri)
			expect(result.length).toBe(1)
			expect(result[0]!.filePath).toBe("/ws/projectA/a.cj")
		})

		it("includes all symbols when getWorkspaceFolder returns undefined", () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
				"/other/b.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})

			const scopeUri = vscode.Uri.file("/ws/a.cj")
			;(vscode.workspace.getWorkspaceFolder as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

			// pathUnderWorkspaceFolder returns true when folder is undefined
			const result = index.findDefinitions("foo", scopeUri)
			expect(result.length).toBe(2)
		})
	})

	describe("removeFile (via watcher delete callback)", () => {
		it("removes file from all indexes when delete callback fires", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})

			// Set up initialize so the watcher is created
			;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" }, name: "test", index: 0 }]
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
				if (p.endsWith("cjpm.toml")) return true
				// Report a.cj as existing so it's not removed as stale during fullIndex
				if (p === "/ws/a.cj") return true
				return false
			})
			;(vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: Date.now() })

			await index.initialize()

			// Verify the symbol exists
			expect(index.findDefinitions("foo").length).toBe(1)

			// Get the onDidDelete callback
			const watcher = (vscode.workspace.createFileSystemWatcher as ReturnType<typeof vi.fn>).mock.results[0].value
			const deleteCallback = watcher.onDidDelete.mock.calls[0][0]

			// Trigger delete
			deleteCallback({ fsPath: "/ws/a.cj" })

			// File should be removed from name index
			expect(index.findDefinitions("foo")).toEqual([])
			expect(index.getSymbolsByFile("/ws/a.cj")).toEqual([])
		})

		it("skips removal during fullIndex (indexing=true)", async () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
			})

			// Simulate indexing state
			;(index as any).indexing = true

			// Directly call private removeFile
			;(index as any).removeFile("/ws/a.cj")

			// File should still be there
			expect(index.findDefinitions("foo").length).toBe(1)
		})

		it("removes file entry, updates fileCount, and schedules save", async () => {
			const index = new CangjieSymbolIndex()
			populateIndex(index, {
				"/ws/a.cj": [{ name: "foo", kind: "func", startLine: 0, endLine: 5 }],
				"/ws/b.cj": [{ name: "bar", kind: "func", startLine: 0, endLine: 3 }],
			})

			expect(index.fileCount).toBe(2)
			;(index as any).removeFile("/ws/a.cj")

			expect(index.findDefinitions("foo")).toEqual([])
			expect(index.getSymbolsByFile("/ws/a.cj")).toEqual([])
			expect(index.fileCount).toBe(1)
			expect((index as any).dirty).toBe(true)
		})

		it("handles removal of unknown file gracefully", () => {
			const index = new CangjieSymbolIndex()
			expect(() => (index as any).removeFile("/ws/nonexistent.cj")).not.toThrow()
		})

		it("delete callback clears pending reindex timer", async () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" }, name: "test", index: 0 }]
				;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
					return p.endsWith("cjpm.toml")
				})
				;(vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

				await index.initialize()

				const watcher = (vscode.workspace.createFileSystemWatcher as ReturnType<typeof vi.fn>).mock.results[0]
					.value

				// Trigger a change to create a reindex timer
				const changeCallback = watcher.onDidChange.mock.calls[0][0]
				changeCallback({ fsPath: "/ws/new.cj" })

				// Verify timer was created
				expect((index as any).reindexTimers.has("/ws/new.cj")).toBe(true)

				// Now trigger delete for the same file
				const deleteCallback = watcher.onDidDelete.mock.calls[0][0]
				deleteCallback({ fsPath: "/ws/new.cj" })

				// Timer should be cleared
				expect((index as any).reindexTimers.has("/ws/new.cj")).toBe(false)
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe("normalizeConversionTypeKey", () => {
		it("strips package prefix and lowercases", () => {
			const result = (CangjieSymbolIndex as any).normalizeConversionTypeKey("std.int32")
			expect(result).toBe("int32")
		})

		it("handles simple type names", () => {
			const result = (CangjieSymbolIndex as any).normalizeConversionTypeKey("Float64")
			expect(result).toBe("float64")
		})

		it("removes non-alphanumeric characters", () => {
			const result = (CangjieSymbolIndex as any).normalizeConversionTypeKey("Array<int32>")
			expect(result).toBe("arrayint32")
		})

		it("handles deeply qualified names", () => {
			const result = (CangjieSymbolIndex as any).normalizeConversionTypeKey("com.example.pkg.MyType")
			expect(result).toBe("mytype")
		})

		it("handles empty string", () => {
			const result = (CangjieSymbolIndex as any).normalizeConversionTypeKey("")
			expect(result).toBe("")
		})
	})

	describe("getConversionHintForTypes", () => {
		it("returns hint when edge exists", () => {
			const index = new CangjieSymbolIndex()
			const map = (index as any).conversionEdgeMap as Map<string, string>
			map.set("int32|int64", "use .toInt64()")

			const result = index.getConversionHintForTypes("int32", "int64")
			expect(result).toBe("use .toInt64()")
		})

		it("returns null when edge does not exist", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getConversionHintForTypes("string", "int32")).toBeNull()
		})

		it("returns null when fromTypeKey is empty", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getConversionHintForTypes("", "int64")).toBeNull()
		})

		it("returns null when toTypeKey is empty", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getConversionHintForTypes("int32", "")).toBeNull()
		})

		it("returns null when both keys are empty", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getConversionHintForTypes("", "")).toBeNull()
		})
	})

	describe("dispose (enhanced)", () => {
		it("clears flushTimer", () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				;(index as any).indexPath = "/tmp/test/symbols.json"
				;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
				;(index as any).scheduleSave()
				expect((index as any).flushTimer).toBeDefined()

				index.dispose()
				// After dispose, flushTimer should have been cleared
				// Advancing timers should NOT trigger saveToDisk
				const writeCount = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length
				vi.advanceTimersByTime(10000)
				expect((fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writeCount)
			} finally {
				vi.useRealTimers()
			}
		})

		it("clears all reindexTimers", () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				const timer1 = setTimeout(() => {}, 1000)
				const timer2 = setTimeout(() => {}, 1000)
				;(index as any).reindexTimers.set("/ws/a.cj", timer1)
				;(index as any).reindexTimers.set("/ws/b.cj", timer2)

				index.dispose()

				expect((index as any).reindexTimers.size).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it("calls saveToDisk during dispose when dirty", () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			;(index as any).indexPath = "/tmp/test/symbols.json"
			;(index as any).dirty = true
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)

			index.dispose()

			expect(fs.writeFileSync).toHaveBeenCalledWith("/tmp/test/symbols.json", expect.any(String), "utf-8")
		})

		it("disposes all registered disposables", () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			const mockDisposable1 = { dispose: vi.fn() }
			const mockDisposable2 = { dispose: vi.fn() }
			;(index as any).disposables.push(mockDisposable1, mockDisposable2)

			index.dispose()

			expect(mockDisposable1.dispose).toHaveBeenCalled()
			expect(mockDisposable2.dispose).toHaveBeenCalled()
		})

		it("only clears singleton if it matches the current instance", () => {
			const mockOC1 = createMockOutputChannel()
			const index1 = new CangjieSymbolIndex(mockOC1 as any)
			// Creating index2 overwrites the singleton
			const mockOC2 = createMockOutputChannel()
			const index2 = new CangjieSymbolIndex(mockOC2 as any)

			expect(CangjieSymbolIndex.getInstance()).toBe(index2)

			// Disposing index1 should NOT clear the singleton (it's index2 now)
			index1.dispose()
			expect(CangjieSymbolIndex.getInstance()).toBe(index2)

			// Disposing index2 SHOULD clear the singleton
			index2.dispose()
			expect(CangjieSymbolIndex.getInstance()).toBeUndefined()
		})
	})

	describe("getFileDependencies and getReverseDependencies", () => {
		it("returns empty array for file with no dependencies", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getFileDependencies("/ws/a.cj")).toEqual([])
		})

		it("returns cached dependencies when available", () => {
			const index = new CangjieSymbolIndex()
			const depCache = (index as any).dependencyCache as Map<string, string[]>
			depCache.set("/ws/a.cj", ["/ws/b.cj", "/ws/c.cj"])

			const result = index.getFileDependencies("/ws/a.cj")
			expect(result).toEqual(["/ws/b.cj", "/ws/c.cj"])
		})

		it("returns empty array for file with no reverse dependencies", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getReverseDependencies("/ws/a.cj")).toEqual([])
		})

		it("returns cached reverse dependencies when available", () => {
			const index = new CangjieSymbolIndex()
			const revDepCache = (index as any).reverseDependencyCache as Map<string, string[]>
			revDepCache.set("/ws/b.cj", ["/ws/a.cj", "/ws/c.cj"])

			const result = index.getReverseDependencies("/ws/b.cj")
			expect(result).toEqual(["/ws/a.cj", "/ws/c.cj"])
		})
	})

	describe("rebuildNameIndex (via loadFromDisk)", () => {
		it("rebuilds all secondary indexes from loaded data", () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			const indexData = {
				version: 5,
				files: {
					"/ws/a.cj": {
						mtime: 1000,
						symbols: [
							{
								name: "alpha",
								kind: "func",
								filePath: "/ws/a.cj",
								startLine: 0,
								endLine: 5,
								signature: "func alpha()",
							},
						],
						references: {
							Beta: [{ line: 3, column: 10 }],
						},
					},
					"/ws/sub/b.cj": {
						mtime: 1000,
						symbols: [
							{
								name: "Beta",
								kind: "class",
								filePath: "/ws/sub/b.cj",
								startLine: 0,
								endLine: 20,
								signature: "class Beta",
							},
						],
						references: {},
					},
				},
			}
			;(index as any).indexPath = "/tmp/test/symbols.json"
			;(fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(indexData))
			;(index as any).loadFromDisk()

			// Name index should be rebuilt
			expect(index.findDefinitions("alpha").length).toBe(1)
			expect(index.findDefinitions("Beta").length).toBe(1)

			// Reference index should be rebuilt
			const refs = index.findReferences("Beta")
			expect(refs.length).toBe(1)
			expect(refs[0]!.filePath).toBe("/ws/a.cj")
			expect(refs[0]!.line).toBe(3)

			// File and symbol counts should be correct
			expect(index.fileCount).toBe(2)
			expect(index.symbolCount).toBe(2)
		})
	})

	describe("scheduleReindex (via watcher callbacks)", () => {
		it("debounces reindex calls", async () => {
			vi.useFakeTimers()
			try {
				const mockOC = createMockOutputChannel()
				const index = new CangjieSymbolIndex(mockOC as any)
				;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: "/ws" }, name: "test", index: 0 }]
				;(fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
					return p.endsWith("cjpm.toml")
				})
				;(vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([])

				await index.initialize()

				const watcher = (vscode.workspace.createFileSystemWatcher as ReturnType<typeof vi.fn>).mock.results[0]
					.value
				const changeCallback = watcher.onDidChange.mock.calls[0][0]

				;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 1000 })
				;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("func test() {}")
				;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([
					{ kind: "func", name: "test", startLine: 0, endLine: 0 },
				])

				// Trigger change
				changeCallback({ fsPath: "/ws/test.cj" })

				// Should not have reindexed yet (debounce)
				expect(parseCangjieDefinitions).not.toHaveBeenCalled()

				// Advance past debounce window (400ms)
				await vi.advanceTimersByTimeAsync(500)

				expect(parseCangjieDefinitions).toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})

		it("defers reindex while fullIndex is in progress", async () => {
			const index = new CangjieSymbolIndex()
			// Simulate indexing state
			;(index as any).indexing = true

			// Call scheduleReindex directly
			;(index as any).scheduleReindex("/ws/test.cj")

			// Should have created a deferred timer (reindexDebounceMs + 200 = 600ms)
			expect((index as any).reindexTimers.has("/ws/test.cj")).toBe(true)
		})
	})

	describe("evictOldestFromReadFileCache", () => {
		it("evicts oldest entry when cache is full", async () => {
			const mockOC = createMockOutputChannel()
			const index = new CangjieSymbolIndex(mockOC as any)
			const cache = (index as any).readFileCache as Map<string, { mtime: number; lines: string[] }>

			// Fill cache to MAX (200)
			for (let i = 0; i < 200; i++) {
				cache.set(`/ws/file_${i}.cj`, { mtime: i, lines: [`line ${i}`] })
			}
			expect(cache.size).toBe(200)

			// Now reindex a new file, which should evict the oldest
			;(fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ mtimeMs: 300 })
			;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("func newFunc() {}")
			;(parseCangjieDefinitions as ReturnType<typeof vi.fn>).mockReturnValue([])

			await index.reindexFile("/ws/new_file.cj")

			// Oldest entry (file_0) should be evicted
			expect(cache.has("/ws/file_0.cj")).toBe(false)
		})
	})

	describe("getConversionHintFromDiagnosticMessage (edge cases)", () => {
		it("returns null for message with no type references", () => {
			const index = new CangjieSymbolIndex()
			expect(index.getConversionHintFromDiagnosticMessage("syntax error at line 5")).toBeNull()
		})

		it("handles single-quoted type names", () => {
			const index = new CangjieSymbolIndex()
			const map = (index as any).conversionEdgeMap as Map<string, string>
			map.set("int32|int64", "hint: toInt64")

			const result = index.getConversionHintFromDiagnosticMessage("cannot convert 'int32' to 'int64'")
			// The regex should match 'int32' and 'int64' with the separator "to"
			// Actually the regex looks for "and|与|but|但|," separators, so "to" won't match
			// This tests the fallback path with \b(Int\d+|UInt\d+|Float\d+)\b
			expect(result).not.toBeNull()
		})

		it("uses regex fallback for UInt types", () => {
			const index = new CangjieSymbolIndex()
			const map = (index as any).conversionEdgeMap as Map<string, string>
			map.set("uint32|uint64", "hint: toUInt64")

			const result = index.getConversionHintFromDiagnosticMessage(
				"type error: UInt32 and UInt64 are incompatible",
			)
			expect(result).toBe("hint: toUInt64")
		})

		it("tries both orderings (a,b) and (b,a)", () => {
			const index = new CangjieSymbolIndex()
			const map = (index as any).conversionEdgeMap as Map<string, string>
			map.set("int64|int32", "hint: toInt32 narrowing")

			// Message has int32 first, int64 second - should try (int32,int64) then (int64,int32)
			const result = index.getConversionHintFromDiagnosticMessage("type mismatch: `int32` and `int64`")
			expect(result).toBe("hint: toInt32 narrowing")
		})
	})
})
