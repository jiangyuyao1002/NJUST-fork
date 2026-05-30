import { describe, it, expect, vi } from "vitest"

const cangjieTestState = vi.hoisted(() => ({
	diagnostics: [] as Array<[any, any[]]>,
	activeTextEditor: null as any,
	activeInfo: null as any,
	rootCause: vi.fn(),
	symbolIndex: null as any,
}))

vi.mock("vscode", () => ({
	window: {
		visibleTextEditors: [],
		get activeTextEditor() {
			return cangjieTestState.activeTextEditor
		},
	},
	languages: {
		getDiagnostics: () => cangjieTestState.diagnostics,
	},
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, fallback: unknown) => fallback,
		}),
		textDocuments: [],
	},
	commands: {
		executeCommand: vi.fn(),
	},
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
	Range: class Range {
		start: { line: number; character: number }
		end: { line: number; character: number }
		constructor(s: number, sc: number, e: number, ec: number) {
			this.start = { line: s, character: sc }
			this.end = { line: e, character: ec }
		}
	},
	Diagnostic: class Diagnostic {
		message: string
		severity: number
		range: InstanceType<typeof Range>
		code?: string | number
		constructor(range: InstanceType<typeof Range>, message: string, severity: number) {
			this.range = range
			this.message = message
			this.severity = severity
		}
	},
}))

vi.mock("../CangjieErrorAnalyzer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../CangjieErrorAnalyzer")>()
	return {
		...actual,
		normalizeDiagnosticCode: (diagnostic: any) => (diagnostic.code == null ? undefined : String(diagnostic.code)),
		resolveCjcPatternForDiagnostic: (diagnostic: any) =>
			/type mismatch|expected/i.test(diagnostic.message)
				? {
						category: "Type mismatch",
						suggestion: "Convert the value before assignment.",
						docPaths: ["types/conversion.md"],
						priority: 90,
					}
				: undefined,
		buildDiagnosticPatternCache: (diagnostics: any[]) =>
			new Map(
				diagnostics.map((diagnostic) => [
					diagnostic,
					{ priority: /high priority/i.test(diagnostic.message) ? 100 : 10 },
				]),
			),
	}
})

vi.mock("../CangjieSymbolExtractor", () => ({
	getActiveCangjieFileInfo: () => cangjieTestState.activeInfo,
}))

vi.mock("../../../../services/cangjie-lsp/cangjieDiagnosticRootCause", () => ({
	traceDiagnosticRootCause: cangjieTestState.rootCause,
}))

vi.mock("../../../../services/cangjie-lsp/CangjieSymbolIndex", () => ({
	CangjieSymbolIndex: {
		getInstance: () => cangjieTestState.symbolIndex,
	},
}))

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"

import { estimateCangjieContextTokensForTest, extractImports } from "../cangjie-context"
import {
	buildAutoCorpusQueries,
	buildStdlibSignatureHintsSection,
	diagnosticToCorpusQuery,
	importPathToCorpusQuery,
} from "../cangjieContext/corpusQueryBuilding"
import {
	buildCompactProjectOverviewSection,
	parseCjpmToml,
	parseCjpmTomlContent,
	readWorkspaceMemberDependencies,
	scanPackageHierarchy,
} from "../cangjieContext/cjpmProjectParser"
import {
	buildConversionHintByMessage,
	buildDiagnosticAugmentationLines,
	collectDiagnosticSnapshot,
	diagnosticTypeFingerprint,
	mapDiagnosticsToDocContext,
	normalizeDiagnosticMessageForAggregation,
	sampleCangjieDiagnostics,
} from "../cangjieContext/diagnosticHandling"
import { testLearnedFixPatternMatchesMessage, testNormalizeLearnedFixText } from "../cangjieContext/learnedFixMatching"
import { userMessageSuggestsCangjie } from "../cangjieContext/cacheManagement"

const makeDiagnostic = (
	message: string,
	severity: number = vscode.DiagnosticSeverity.Error,
	line = 0,
	code?: string | number,
) => {
	const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, 5), message, severity as any)
	diagnostic.code = code
	return diagnostic
}

describe("userMessageSuggestsCangjie (Ask/Architect 语料触发)", () => {
	it("matches toolchain tokens and 仓颉", () => {
		expect(userMessageSuggestsCangjie("如何用 cjpm build")).toBe(true)
		expect(userMessageSuggestsCangjie("仓颉的泛型怎么写")).toBe(true)
		expect(userMessageSuggestsCangjie("read foo.cj file")).toBe(true)
	})
	it("returns false for unrelated text", () => {
		expect(userMessageSuggestsCangjie("hello world")).toBe(false)
		expect(userMessageSuggestsCangjie(undefined)).toBe(false)
	})
})

describe("estimateCangjieContextTokensForTest", () => {
	it("中英文内容均产生正 token 估计", () => {
		const zh = estimateCangjieContextTokensForTest("仓颉语言类型系统")
		const en = estimateCangjieContextTokensForTest("cangjie language type system")
		expect(zh).toBeGreaterThan(0)
		expect(en).toBeGreaterThan(0)
	})

	it("代码符号应产生可见 token 成本", () => {
		const plain = estimateCangjieContextTokensForTest("abcdef")
		const code = estimateCangjieContextTokensForTest("Map<String, Int64> {}")
		expect(code).toBeGreaterThan(plain)
	})

	it("空文本返回 0", () => {
		expect(estimateCangjieContextTokensForTest("")).toBe(0)
	})
})

describe("learned-fix similarity (Cangjie Dev)", () => {
	it("normalizes file paths and line numbers for stable matching", () => {
		const a = testNormalizeLearnedFixText("Error at D:\\proj\\src\\foo.cj:42:10 type mismatch")
		const b = testNormalizeLearnedFixText("Error at E:\\other\\bar.cj:99:1 type mismatch")
		expect(a).toContain("FILE")
		expect(a).toContain(":L:L")
		expect(a.replace(/FILE/g, "X")).toBe(b.replace(/FILE/g, "X"))
	})

	it("matches bilingual type mismatch with lowered threshold", () => {
		const p = {
			errorPattern: "type mismatch: expected Int32, found String",
			fix: "cast or parse",
		}
		const ok = testLearnedFixPatternMatchesMessage(p, "类型不匹配：需要 Int32 但得到了 String")
		expect(ok).toBe(true)
	})

	it("matches when diagnostic code equals bracket tag in pattern", () => {
		const p = { errorPattern: "[E1234] something failed", fix: "x" }
		expect(testLearnedFixPatternMatchesMessage(p, "unrelated text", "E1234")).toBe(true)
	})

	it("honors optional diagnosticCode on learned pattern", () => {
		const p = { errorPattern: "any", fix: "x", diagnosticCode: "E42" }
		expect(testLearnedFixPatternMatchesMessage(p, "msg", "E42")).toBe(true)
		expect(testLearnedFixPatternMatchesMessage(p, "msg", "E99")).toBe(false)
	})
})

describe("extractImports (brace syntax)", () => {
	it("captures package prefix for import pkg.{ ... }", () => {
		const src = `
import std.io.{InputStream, OutputStream}
from std.collection import HashMap
import std.console.*
`
		const im = extractImports(src)
		expect(im).toContain("std.io")
		expect(im).toContain("std.collection")
		expect(im).toContain("std.console")
	})
})

describe("corpus query building", () => {
	it("converts import paths into compact search terms", () => {
		expect(importPathToCorpusQuery("std.collection.HashMap")).toBe("collection HashMap")
		expect(importPathToCorpusQuery("std.console.*")).toBe("std console")
		expect(importPathToCorpusQuery("*")).toBeNull()
		expect(importPathToCorpusQuery("LocalModule")).toBe("LocalModule")
	})

	it("derives diagnostic queries from plain messages", () => {
		const diagnostic = {
			message: "error: custom package foo failed at line 42 because helper token vanished",
		} as any

		const query = diagnosticToCorpusQuery(diagnostic)

		expect(query).toContain("custom")
		expect(query).toContain("package")
		expect(query).not.toContain("42")
	})

	it("groups std imports by family and limits merged queries", () => {
		const diagnostics = [
			{ message: "error: undeclared identifier println" },
			{ message: "warning: type mismatch expected Int64 found String" },
		] as any[]

		const queries = buildAutoCorpusQueries(
			[
				"std.collection.HashMap",
				"std.collection.ArrayList",
				"std.io.File",
				"my.project.LocalType",
				"other.module.Helper",
			],
			diagnostics,
		)

		expect(queries.length).toBeLessThanOrEqual(5)
		expect(queries.some((q) => q.includes("collection HashMap"))).toBe(true)
		expect(queries.some((q) => q.includes("io File"))).toBe(true)
		expect(queries.some((q) => q.includes("project LocalType"))).toBe(true)
		expect(queries.at(-1)?.length).toBeGreaterThan(0)
	})

	it("returns stdlib signature hints for matching standard imports", async () => {
		const section = await buildStdlibSignatureHintsSection(
			["std.collection.HashMap", "std.io.File", "local.Project"],
			null,
		)

		expect(section).toBeTruthy()
		expect(section).toContain("std.collection")
	})

	it("omits stdlib signature hints when no std imports match", async () => {
		await expect(buildStdlibSignatureHintsSection(["local.Project"], null)).resolves.toBeNull()
	})
})

describe("parseCjpmToml (smol-toml + fallback)", () => {
	it("reads package fields from valid TOML", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "njust-ai-cjpm-"))
		try {
			fs.writeFileSync(
				path.join(dir, "cjpm.toml"),
				`
[package]
name = "demo_pkg"
version = "0.2.0"
output-type = "executable"
src-dir = "src2"

# trailing comment
`,
				"utf-8",
			)
			const info = await parseCjpmToml(dir)
			expect(info?.name).toBe("demo_pkg")
			expect(info?.version).toBe("0.2.0")
			expect(info?.srcDir).toBe("src2")
			expect(info?.isWorkspace).toBe(false)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	it("parses multiline string in workspace member dependency (smol path)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "njust-ai-ws-"))
		try {
			const mod = path.join(root, "core")
			fs.mkdirSync(mod, { recursive: true })
			fs.writeFileSync(
				path.join(root, "cjpm.toml"),
				`
[workspace]
members = [ "core" ]

[dependencies]
rootdep = { path = "./x" }
`,
				"utf-8",
			)
			fs.writeFileSync(
				path.join(mod, "cjpm.toml"),
				`
[package]
name = "core"
output-type = "static"

[dependencies]
peer = { path = "../peer" }
`,
				"utf-8",
			)
			const info = await parseCjpmToml(root)
			expect(info?.isWorkspace).toBe(true)
			expect(info?.members?.length).toBeGreaterThanOrEqual(1)
			const core = info?.members?.find((m) => m.name === "core")
			expect(core?.outputType).toBe("static")
			expect(core?.dependencies?.peer?.path).toBe("../peer")
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
})

describe("diagnostic handling", () => {
	it("builds stable fingerprints from quoted and primitive types", () => {
		expect(diagnosticTypeFingerprint("expected `Foo Bar` but got `Baz`")).toBe("foobar|baz")
		expect(diagnosticTypeFingerprint("expected Int64 but got String and Int64")).toBe("int64|string")
		expect(diagnosticTypeFingerprint("plain message")).toBe("")
	})

	it("normalizes diagnostic messages for aggregation", () => {
		const normalized = normalizeDiagnosticMessageForAggregation(
			"[E001] D:\\proj\\src\\main.cj: type mismatch expected `Foo Bar`",
		)

		expect(normalized).not.toContain("D:\\proj")
		expect(normalized).not.toContain("[E001]")
		expect(normalized).toContain("type mismatch")
		expect(normalized).toContain("foobar")
	})

	it("collects Cangjie diagnostics and ignores non-Cangjie files", () => {
		const cjUri = { fsPath: path.join("D:", "proj", "main.cj"), toString: () => "file:///D:/proj/main.cj" }
		const tsUri = { fsPath: path.join("D:", "proj", "main.ts"), toString: () => "file:///D:/proj/main.ts" }
		const diagnostic = makeDiagnostic("type mismatch expected Int64", vscode.DiagnosticSeverity.Error, 3, "E001")
		cangjieTestState.diagnostics = [
			[cjUri, [diagnostic]],
			[tsUri, [makeDiagnostic("ignored")]],
		]

		const snapshot = collectDiagnosticSnapshot()

		expect(snapshot.allCjDiags).toEqual([diagnostic])
		expect(snapshot.byFile.size).toBe(1)
		expect(snapshot.diagSummaryHash).toBeGreaterThan(0)
		cangjieTestState.diagnostics = []
	})

	it("samples diagnostics by severity, aggregation bucket, and limits", () => {
		const first = makeDiagnostic(
			"high priority type mismatch expected Int64",
			vscode.DiagnosticSeverity.Error,
			0,
			"E1",
		)
		const duplicate = makeDiagnostic(
			"high priority type mismatch expected Int64",
			vscode.DiagnosticSeverity.Error,
			2,
			"E1",
		)
		const warning = makeDiagnostic("warning: unused value", vscode.DiagnosticSeverity.Warning, 5, "W1")
		const info = makeDiagnostic("info only", vscode.DiagnosticSeverity.Information, 7, "I1")

		const result = sampleCangjieDiagnostics([warning, info, duplicate, first], { maxErrors: 1, maxWarnings: 1 })

		expect(result.total).toBe(4)
		expect(result.sampled).toHaveLength(2)
		expect(result.sampled[0]?.message).toContain("high priority")
		expect(result.sampled[0]?.message).toContain("2")
		expect(result.sampled[1]).toBe(warning)
		expect(result.omitted).toBe(1)
	})

	it("maps diagnostics to doc context and conversion hints", () => {
		const diagnostic = makeDiagnostic("type mismatch expected String", vscode.DiagnosticSeverity.Error, 0, "E001")
		const lines = mapDiagnosticsToDocContext(
			[diagnostic, diagnostic],
			"D:\\docs",
			new Map([[diagnostic.message, "Try String.from(value)."]]),
		)

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("Type mismatch")
		expect(lines[0]).toContain("code: E001")
		expect(lines[0]).toContain("types/conversion.md")
		expect(lines[0]).toContain("Try String.from(value).")
	})

	it("adds root-cause and conversion augmentation lines once", () => {
		const diagnostic = makeDiagnostic("type mismatch expected String", vscode.DiagnosticSeverity.Error, 0, "E002")
		cangjieTestState.rootCause.mockReturnValue("root declaration has incompatible type")

		const lines = buildDiagnosticAugmentationLines(
			[diagnostic, diagnostic],
			"D:\\proj",
			new Map([[diagnostic.message, "Use explicit conversion."]]),
			new Map(),
		)

		expect(lines).toEqual(["- root declaration has incompatible type", "- Use explicit conversion."])
		cangjieTestState.rootCause.mockReset()
	})

	it("builds conversion hints only for matching diagnostic messages", () => {
		cangjieTestState.symbolIndex = {
			getConversionHintFromDiagnosticMessage: vi.fn((message: string) =>
				message.includes("String") ? "Use String.from" : undefined,
			),
		}

		const matching = makeDiagnostic("type mismatch expected String", vscode.DiagnosticSeverity.Error)
		const ignored = makeDiagnostic("unrelated parser error", vscode.DiagnosticSeverity.Error)
		const hints = buildConversionHintByMessage([matching, ignored])

		expect(hints.get(matching.message)).toBe("Use String.from")
		expect(hints.has(ignored.message)).toBe(false)
		cangjieTestState.symbolIndex = null
	})
})

describe("cjpm project parser helpers", () => {
	it("parses package dependencies from TOML content without reading files", async () => {
		const info = await parseCjpmTomlContent(
			`
[package]
name = "demo"
version = "1.2.3"
output-type = "static"
src-dir = "source"

[dependencies]
local = { path = "../local" }
remote = { git = "https://example.test/repo.git", branch = "main" }
tagged = { git = "https://example.test/repo.git", tag = "v1" }
`,
			process.cwd(),
		)

		expect(info).toMatchObject({
			name: "demo",
			version: "1.2.3",
			outputType: "static",
			srcDir: "source",
			isWorkspace: false,
		})
		expect(info?.dependencies?.local?.path).toBe("../local")
		expect(info?.dependencies?.remote?.branch).toBe("main")
		expect(info?.dependencies?.tagged?.tag).toBe("v1")
	})

	it("reads dependency display from member metadata before touching files", async () => {
		const deps = await readWorkspaceMemberDependencies(process.cwd(), {
			name: "core",
			path: "core",
			outputType: "static",
			dependencyDisplay: ["a", "b", "c", "d", "e", "f"],
		})

		expect(deps).toEqual(["a", "b", "c", "d", "e"])
	})

	it("scans package hierarchy with source, test, main, and child packages", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "njust-ai-cjpm-scan-"))
		const leaf = path.join(root, "src", "network", "http")
		fs.mkdirSync(leaf, { recursive: true })
		fs.writeFileSync(path.join(root, "src", "main.cj"), "main() {}", "utf-8")
		fs.writeFileSync(path.join(root, "src", "main_test.cj"), "test {}", "utf-8")
		fs.writeFileSync(path.join(leaf, "client.cj"), "package demo.network.http", "utf-8")

		const tree = await scanPackageHierarchy(root, "src", "demo")

		expect(tree).toMatchObject({
			packageName: "demo",
			dirPath: "src",
			sourceFiles: ["main.cj"],
			testFiles: ["main_test.cj"],
			hasMain: true,
		})
		expect(tree?.children[0]?.children[0]).toMatchObject({
			packageName: "demo.network.http",
			dirPath: "src/network/http",
			sourceFiles: ["client.cj"],
		})
	})

	it("builds a compact overview for single-module projects", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "njust-ai-cjpm-overview-"))
		fs.mkdirSync(path.join(root, "src", "sub"), { recursive: true })
		fs.writeFileSync(path.join(root, "src", "main.cj"), "main() {}", "utf-8")
		fs.writeFileSync(path.join(root, "src", "sub", "helper.cj"), "package demo.sub", "utf-8")

		const section = await buildCompactProjectOverviewSection(
			root,
			{
				name: "demo",
				version: "0.1.0",
				outputType: "executable",
				isWorkspace: false,
				srcDir: "src",
			},
			"demo.sub",
			path.join(root, "src", "sub", "helper.cj"),
		)

		expect(section).toContain("demo")
		expect(section).toContain("executable")
		expect(section).toContain("src/")
		expect(section).toContain("demo.sub")
	})
})
