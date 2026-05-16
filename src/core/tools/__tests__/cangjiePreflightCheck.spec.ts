import fs from "fs/promises"
import os from "os"
import path from "path"

import { describe, expect, it } from "vitest"

import {
	CRITICAL_SIGNATURE_MODULES,
	buildSearchGateWarning,
	cangjiePreflightCheck,
	extractStdImports,
	extractStdModulesFromQuery,
	inferPackageFromPath,
	resolveRootPackageName,
} from "../cangjiePreflightCheck"

describe("inferPackageFromPath", () => {
	it("infers nested package from src-relative path", () => {
		expect(inferPackageFromPath("src/foo/bar/baz.cj", "/repo", "root")).toBe("foo.bar")
	})

	it("handles windows path separators", () => {
		expect(inferPackageFromPath("src\\foo\\bar.cj", "/repo", "root")).toBe("foo")
	})

	it("uses root package for files directly under src", () => {
		expect(inferPackageFromPath("src/main.cj", "/repo", "rootpkg")).toBe("rootpkg")
	})

	it("returns null when path is outside src", () => {
		expect(inferPackageFromPath("tests/main.cj", "/repo", "root")).toBeNull()
	})
})

describe("extractStdImports", () => {
	it("extracts unique std top-level modules", () => {
		const content = [
			"import std.collection.HashMap",
			"import std.collection.ArrayList",
			"import std.fs.File",
			"import my.pkg.Type",
		].join("\n")

		expect(extractStdImports(content).sort()).toEqual(["std.collection", "std.fs"])
	})
})

describe("cangjiePreflightCheck", () => {
	it("passes matching package and explicit Int64 main", () => {
		const result = cangjiePreflightCheck(
			"package foo.bar\nfunc main(): Int64 { return 0 }",
			"src/foo/bar/main.cj",
			"/repo",
			"root",
		)

		expect(result).toEqual({ pass: true, warnings: [], errors: [] })
	})

	it("errors when package declaration does not match target path", () => {
		const result = cangjiePreflightCheck("package wrong", "src/foo/main.cj", "/repo", "root")

		expect(result.pass).toBe(false)
		expect(result.errors[0]).toContain('"wrong"')
		expect(result.errors[0]).toContain('"foo"')
	})

	it("warns when main lacks explicit return type", () => {
		const result = cangjiePreflightCheck("func main() { return 0 }", "src/main.cj", "/repo", "root")

		expect(result.pass).toBe(true)
		expect(result.warnings[0]).toContain("main()")
	})

	it("errors when main return type is not Int64", () => {
		const result = cangjiePreflightCheck("func main(): Unit {}", "src/main.cj", "/repo", "root")

		expect(result.pass).toBe(false)
		expect(result.errors[0]).toContain("Int64")
		expect(result.errors[0]).toContain("Unit")
	})

	it("errors on direct struct self-reference", () => {
		const result = cangjiePreflightCheck("struct Node { let next: Node }", "src/node.cj", "/repo", "root")

		expect(result.pass).toBe(false)
		expect(result.errors[0]).toContain("struct Node")
	})

	it("allows optional struct self-reference", () => {
		const result = cangjiePreflightCheck("struct Node { let next: Node? }", "src/node.cj", "/repo", "root")

		expect(result.pass).toBe(true)
		expect(result.errors).toEqual([])
	})

	it("warns for unknown std top-level module", () => {
		const result = cangjiePreflightCheck("import std.unknown.Foo", "src/main.cj", "/repo", "root")

		expect(result.pass).toBe(true)
		expect(result.warnings[0]).toContain("std.unknown")
	})

	it("does not warn for known std top-level module", () => {
		const result = cangjiePreflightCheck("import std.fs.File", "src/main.cj", "/repo", "root")

		expect(result.warnings).toEqual([])
	})
})

describe("buildSearchGateWarning", () => {
	it("returns null when all std modules were searched or exempt", () => {
		const content = "import std.console.Console\nimport std.fs.File"

		expect(buildSearchGateWarning(content, new Set(["std.fs"]), CRITICAL_SIGNATURE_MODULES)).toBeNull()
	})

	it("returns warning listing unsearched non-critical modules", () => {
		const warning = buildSearchGateWarning(
			"import std.net.Socket\nimport std.time.DateTime",
			new Set(["std.time"]),
			new Set(),
		)

		expect(warning).toContain("<cangjie_search_gate>")
		expect(warning).toContain("- std.net")
		expect(warning).not.toContain("- std.time")
	})
})

describe("extractStdModulesFromQuery", () => {
	it("extracts unique modules from regex and semantic query", () => {
		expect(extractStdModulesFromQuery("std.fs.File|std.net.Socket", "std.fs open file").sort()).toEqual([
			"std.fs",
			"std.net",
		])
	})
})

describe("resolveRootPackageName", () => {
	it("reads package name from cjpm.toml", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cjpm-root-"))
		try {
			await fs.writeFile(path.join(dir, "cjpm.toml"), '[package]\nname = "demo_pkg"\n')

			await expect(resolveRootPackageName(dir)).resolves.toBe("demo_pkg")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("returns undefined when cjpm.toml is missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cjpm-missing-"))
		try {
			await expect(resolveRootPackageName(dir)).resolves.toBeUndefined()
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
