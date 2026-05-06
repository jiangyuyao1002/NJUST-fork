import fs from "fs/promises"
import os from "os"
import path from "path"

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

import { CangjieRuntimePolicy, isAllowedCangjieCommand } from "../CangjieRuntimePolicy"

describe("CangjieRuntimePolicy", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-cangjie-policy-"))
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("blocks .cj writes before cjpm project initialization", async () => {
		const policy = new CangjieRuntimePolicy(tempDir)

		await expect(policy.ensureProjectInitializedForWrite("src/main.cj")).resolves.toContain("cjpm project")
		await expect(policy.ensureProjectInitializedForWrite("README.md")).resolves.toBeNull()
	})

	it("allows .cj writes after cjpm.toml exists", async () => {
		const policy = new CangjieRuntimePolicy(tempDir)
		await fs.writeFile(path.join(tempDir, "cjpm.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\n', "utf8")
		policy.invalidateProjectCache()

		await expect(policy.ensureProjectInitializedForWrite("src/main.cj")).resolves.toBeNull()
	})

	it("validates Cangjie source layout and package declarations", async () => {
		const policy = new CangjieRuntimePolicy(tempDir)
		await fs.mkdir(path.join(tempDir, "src", "foo"), { recursive: true })
		await fs.writeFile(path.join(tempDir, "cjpm.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\n', "utf8")
		policy.invalidateProjectCache()

		await expect(
			policy.validateProjectStructureForWrite("main.cj", "package demo\nmain(): Int64 { return 0 }\n"),
		).resolves.toContain("Allowed source roots")
		await expect(
			policy.validateProjectStructureForWrite("src/foo/bar.cj", "package wrong\nclass A {}\n"),
		).resolves.toContain('expected "package foo"')
		await expect(
			policy.validateProjectStructureForWrite("src/foo/bar.cj", "package foo\nclass A {}\n"),
		).resolves.toBeNull()
	})

	it("validates cjpm.toml does not mix package and workspace roots", async () => {
		const policy = new CangjieRuntimePolicy(tempDir)

		await expect(
			policy.validateProjectStructureForWrite("cjpm.toml", "[package]\nname = \"demo\"\n[workspace]\nmembers = []\n"),
		).resolves.toContain("[package] and [workspace]")
	})

	it("requires a successful build after Cangjie source changes before completion", () => {
		const policy = new CangjieRuntimePolicy(tempDir)

		policy.noteWriteApplied("src/main.cj", "main() {}", "main() { println(\"hi\") }")
		expect(policy.getAttemptCompletionBlockReason()).toContain("last successful build")

		policy.noteBuildResult("cjpm build", true, "build ok")
		expect(policy.getAttemptCompletionBlockReason()).toBeNull()
		expect(policy.getContextIntensity(2)).toBe("compact")
	})

	it("tracks missing stdlib evidence until corpus evidence is recorded", () => {
		const policy = new CangjieRuntimePolicy(tempDir)
		const previousContent = "import std.io\nmain() {}\n"
		const nextContent = "import std.io\nimport std.collection\nmain() {}\n"

		expect(policy.getMissingImportEvidence(previousContent, nextContent)).toEqual([])

		policy.noteCorpusSearch(["std.collection"], "std.collection HashMap")
		expect(policy.getMissingImportEvidence(previousContent, nextContent)).toEqual([])
	})

	it("surfaces build root causes and upgrades prompt detail after build failure", () => {
		const policy = new CangjieRuntimePolicy(tempDir)

		policy.noteWriteApplied("src/main.cj", "main() {}", "main() { let x: Int32 = \"oops\" }")
		policy.noteBuildResult("cjpm build", true, "build ok")
		policy.noteBuildResult("cjpm build", false, "type mismatch: expected Int32, found String")

		expect(policy.getRecentBuildRootCauses()).toContain("类型不匹配")
		expect(policy.getRepairDirective()).toContain("fix only the top root cause")
		expect(policy.getAttemptCompletionBlockReason()).toContain("latest build failed")
		expect(policy.getContextIntensity(1)).toBe("full")
	})

	it("records LSP evidence in the unified evidence registry", () => {
		const policy = new CangjieRuntimePolicy(tempDir)

		policy.noteLspEvidence("hover", "src/main.cj:3:8", "func println(value: String)")

		expect([...policy.evidenceRecords.keys()]).toContain("lsp_hover:src/main.cj:3:8")
	})
})

describe("isAllowedCangjieCommand", () => {
	it("allows toolchain and read-only helper commands", () => {
		expect(isAllowedCangjieCommand("cjpm build")).toBe(true)
		expect(isAllowedCangjieCommand("Set-Location src && cjfmt -f main.cj")).toBe(true)
		expect(isAllowedCangjieCommand("Get-Content src/main.cj")).toBe(true)
	})

	it("blocks unrelated commands", () => {
		expect(isAllowedCangjieCommand("npm test")).toBe(false)
		expect(isAllowedCangjieCommand("python script.py")).toBe(false)
	})
})
