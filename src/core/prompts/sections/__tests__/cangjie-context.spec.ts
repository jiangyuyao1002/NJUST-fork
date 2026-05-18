import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		visibleTextEditors: [],
		activeTextEditor: null,
	},
	languages: {
		getDiagnostics: () => [],
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

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

import {
	estimateCangjieContextTokensForTest,
	extractImports,
} from "../cangjie-context"
import { parseCjpmToml } from "../cangjieContext/cjpmProjectParser"
import {
	testLearnedFixPatternMatchesMessage,
	testNormalizeLearnedFixText,
} from "../cangjieContext/learnedFixMatching"
import { userMessageSuggestsCangjie } from "../cangjieContext/cacheManagement"

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
		const ok = testLearnedFixPatternMatchesMessage(
			p,
			"类型不匹配：需要 Int32 但得到了 String",
		)
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

describe("parseCjpmToml (smol-toml + fallback)", () => {
	it("reads package fields from valid TOML", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-cjpm-"))
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
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "roo-ws-"))
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

