// npx vitest core/prompts/services/__tests__/ImportContextResolver.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	window: {
		visibleTextEditors: [],
	},
}))

vi.mock("fs", () => ({
	existsSync: vi.fn(),
	statSync: vi.fn(),
	readdirSync: vi.fn(),
	readFileSync: vi.fn(),
}))

import * as fs from "fs"

import {
	extractDefs,
	resolveRelativePath,
	resolveCppInclude,
	resolveJavaImport,
	resolvePythonImport,
	resolveGoImport,
	resolveRustImport,
	resolveTsImport,
	LANGUAGE_CONFIGS,
	getLanguageConfig,
	extractImportsForLanguage,
	collectFilesInDir,
	extractFileContext,
	formatResolvedContext,
	LANGUAGE_DISPLAY_NAMES,
	type ImportResult,
} from "../ImportContextResolver"

const existsSyncMock = vi.fn()
const statSyncMock = vi.fn()
const readdirSyncMock = vi.fn()
const readFileSyncMock = vi.fn()

fs.existsSync = existsSyncMock
fs.statSync = statSyncMock
fs.readdirSync = readdirSyncMock
fs.readFileSync = readFileSyncMock

describe("ImportContextResolver", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("extractDefs", () => {
		it("should extract C++ definitions", () => {
			const content = `
class MyClass {
};
struct MyStruct {
};
enum MyEnum {
};
namespace myNamespace {
}
void myFunction(int x);
			`
			const patterns = [
				{ re: /^[ \t]*(?:template\s*<[^>]*>\s*)?class\s+(\w+)/, kind: "class" },
				{ re: /^[ \t]*(?:template\s*<[^>]*>\s*)?struct\s+(\w+)/, kind: "struct" },
				{ re: /^[ \t]*enum\s+(?:class\s+)?(\w+)/, kind: "enum" },
				{ re: /^[ \t]*namespace\s+(\w+)/, kind: "namespace" },
				{
					re: /^[ \t]*(?:(?:static|inline|virtual|explicit|constexpr|extern|friend)\s+)*(?:[\w:*&<>,\s]+)\s+(\w+)\s*\(/,
					kind: "func",
				},
			]
			const defs = extractDefs(content, patterns)

			expect(defs.some((d) => d.name === "MyClass" && d.kind === "class")).toBe(true)
			expect(defs.some((d) => d.name === "MyStruct" && d.kind === "struct")).toBe(true)
			expect(defs.some((d) => d.name === "MyEnum" && d.kind === "enum")).toBe(true)
			expect(defs.some((d) => d.name === "myNamespace" && d.kind === "namespace")).toBe(true)
			expect(defs.some((d) => d.name === "myFunction" && d.kind === "func")).toBe(true)
		})

		it("should extract Python definitions", () => {
			const content = `
class MyClass:
    pass

def my_function():
    pass

async def async_function():
    pass
			`
			const patterns = [
				{ re: /^class\s+(\w+)/, kind: "class" },
				{ re: /^def\s+(\w+)/, kind: "func" },
				{ re: /^async\s+def\s+(\w+)/, kind: "func" },
			]
			const defs = extractDefs(content, patterns)

			expect(defs.some((d) => d.name === "MyClass" && d.kind === "class")).toBe(true)
			expect(defs.some((d) => d.name === "my_function" && d.kind === "func")).toBe(true)
			expect(defs.some((d) => d.name === "async_function" && d.kind === "func")).toBe(true)
		})

		it("should extract TypeScript definitions", () => {
			const content = `
export class MyClass {}
export interface MyInterface {}
export type MyType = string;
export enum MyEnum {}
export function myFunction() {}
export const myConst = 42;
			`
			const patterns = [
				{ re: /^[ \t]*export\s+(?:default\s+)?class\s+(\w+)/, kind: "class" },
				{ re: /^[ \t]*export\s+(?:default\s+)?interface\s+(\w+)/, kind: "interface" },
				{ re: /^[ \t]*export\s+(?:default\s+)?type\s+(\w+)/, kind: "type" },
				{ re: /^[ \t]*export\s+(?:default\s+)?enum\s+(\w+)/, kind: "enum" },
				{ re: /^[ \t]*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/, kind: "func" },
				{ re: /^[ \t]*export\s+(?:const|let|var)\s+(\w+)/, kind: "const" },
			]
			const defs = extractDefs(content, patterns)

			expect(defs.some((d) => d.name === "MyClass" && d.kind === "class")).toBe(true)
			expect(defs.some((d) => d.name === "MyInterface" && d.kind === "interface")).toBe(true)
			expect(defs.some((d) => d.name === "MyType" && d.kind === "type")).toBe(true)
			expect(defs.some((d) => d.name === "MyEnum" && d.kind === "enum")).toBe(true)
			expect(defs.some((d) => d.name === "myFunction" && d.kind === "func")).toBe(true)
			expect(defs.some((d) => d.name === "myConst" && d.kind === "const")).toBe(true)
		})

		it("should return empty array for empty content", () => {
			const defs = extractDefs("", [])
			expect(defs).toEqual([])
		})
	})

	describe("resolveRelativePath", () => {
		it("should resolve relative TypeScript imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("helper.ts")
			})
			statSyncMock.mockReturnValue({ isFile: () => true })

			const result = resolveRelativePath("./helper", "/project", "/project/src/main.ts")
			expect(result).not.toBeNull()
			expect(result).toContain("helper")
		})

		it("should return null for non-relative imports", () => {
			const result = resolveRelativePath("lodash", "/project", "/project/src/main.ts")
			expect(result).toBeNull()
		})

		it("should return null when file does not exist", () => {
			existsSyncMock.mockReturnValue(false)

			const result = resolveRelativePath("./missing", "/project", "/project/src/main.ts")
			expect(result).toBeNull()
		})
	})

	describe("resolveCppInclude", () => {
		it("should resolve local includes", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("header.h")
			})

			const imp: ImportResult = { raw: '#include "header.h"', modulePath: "header.h" }
			const result = resolveCppInclude(imp, "/project", "/project/src/main.cpp")
			expect(result).not.toBeNull()
		})

		it("should check include directories", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				// Only match the include directory path, not local or root paths
				return p === "/project/include/header.h" || p.endsWith("\\include\\header.h")
			})

			const imp: ImportResult = { raw: '#include "header.h"', modulePath: "header.h" }
			const result = resolveCppInclude(imp, "/project", "/project/src/main.cpp")
			expect(result).not.toBeNull()
		})
	})

	describe("resolveJavaImport", () => {
		it("should resolve Java imports to source files", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("MyClass.java")
			})

			const imp: ImportResult = { raw: "import com.example.MyClass;", modulePath: "com.example.MyClass" }
			const result = resolveJavaImport(imp, "/project", "/project/src/main.java")
			expect(result).not.toBeNull()
			expect(result).toContain("MyClass.java")
		})

		it("should handle wildcard imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				// Match the directory path for wildcard import
				const normalized = p.replace(/\\/g, "/")
				return normalized.endsWith("com/example") && normalized.includes("src/main/java")
			})
			statSyncMock.mockReturnValue({ isDirectory: () => true })

			const imp: ImportResult = { raw: "import com.example.*;", modulePath: "com.example.*" }
			const result = resolveJavaImport(imp, "/project", "/project/src/main.java")
			expect(result).not.toBeNull()
		})
	})

	describe("resolvePythonImport", () => {
		it("should resolve Python module imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("my_module.py")
			})

			const imp: ImportResult = { raw: "import my_module", modulePath: "my_module" }
			const result = resolvePythonImport(imp, "/project", "/project/src/main.py")
			expect(result).not.toBeNull()
			expect(result).toContain("my_module.py")
		})

		it("should resolve Python package imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				const normalized = p.replace(/\\/g, "/")
				return normalized.includes("my_package/__init__.py")
			})

			const imp: ImportResult = { raw: "import my_package", modulePath: "my_package" }
			const result = resolvePythonImport(imp, "/project", "/project/src/main.py")
			expect(result).not.toBeNull()
		})
	})

	describe("resolveGoImport", () => {
		it("should resolve Go package imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("mypackage") && !p.includes("/mypackage.")
			})
			statSyncMock.mockReturnValue({ isDirectory: () => true })

			const imp: ImportResult = {
				raw: 'import "github.com/user/mypackage"',
				modulePath: "github.com/user/mypackage",
			}
			const result = resolveGoImport(imp, "/project", "/project/src/main.go")
			expect(result).not.toBeNull()
		})

		it("should check internal and pkg directories", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				const normalized = p.replace(/\\/g, "/")
				// Only match internal directory, not root
				return normalized.endsWith("internal/mypackage")
			})
			statSyncMock.mockReturnValue({ isDirectory: () => true })

			const imp: ImportResult = { raw: 'import "mypackage"', modulePath: "mypackage" }
			const result = resolveGoImport(imp, "/project", "/project/src/main.go")
			expect(result).not.toBeNull()
		})
	})

	describe("resolveRustImport", () => {
		it("should resolve Rust module imports", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				const normalized = p.replace(/\\/g, "/")
				return normalized.endsWith("src/my_module.rs")
			})

			const imp: ImportResult = { raw: "use crate::my_module;", modulePath: "::my_module" }
			const result = resolveRustImport(imp, "/project", "/project/src/main.rs")
			expect(result).not.toBeNull()
			expect(result).toContain("my_module.rs")
		})

		it("should resolve Rust directory modules", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				const normalized = p.replace(/\\/g, "/")
				return normalized.endsWith("src/my_mod/mod.rs")
			})

			const imp: ImportResult = { raw: "mod my_mod;", modulePath: "my_mod" }
			const result = resolveRustImport(imp, "/project", "/project/src/main.rs")
			expect(result).not.toBeNull()
			expect(result).toContain("mod.rs")
		})
	})

	describe("resolveTsImport", () => {
		it("should delegate to resolveRelativePath", () => {
			existsSyncMock.mockImplementation(function (p: string) {
				return p.includes("helper.ts")
			})
			statSyncMock.mockReturnValue({ isFile: () => true })

			const imp: ImportResult = { raw: "import { x } from './helper'", modulePath: "./helper" }
			const result = resolveTsImport(imp, "/project", "/project/src/main.ts")
			expect(result).not.toBeNull()
			expect(result).toContain("helper")
		})
	})

	describe("LANGUAGE_CONFIGS", () => {
		it("should have configurations for supported languages", () => {
			const languageIds = LANGUAGE_CONFIGS.flatMap((c) => c.languageIds)
			expect(languageIds).toContain("cpp")
			expect(languageIds).toContain("java")
			expect(languageIds).toContain("python")
			expect(languageIds).toContain("go")
			expect(languageIds).toContain("rust")
			expect(languageIds).toContain("typescript")
			expect(languageIds).toContain("javascript")
		})
	})

	describe("getLanguageConfig", () => {
		it("should return config for supported languages", () => {
			expect(getLanguageConfig("typescript")).not.toBeNull()
			expect(getLanguageConfig("python")).not.toBeNull()
			expect(getLanguageConfig("rust")).not.toBeNull()
		})

		it("should return null for unsupported languages", () => {
			expect(getLanguageConfig("ruby")).toBeNull()
			expect(getLanguageConfig("php")).toBeNull()
		})
	})

	describe("extractImportsForLanguage", () => {
		it("should extract TypeScript imports", () => {
			const content = `
import { something } from './module';
import * as utils from '../utils';
const x = require('./other');
			`
			const config = getLanguageConfig("typescript")!
			const imports = extractImportsForLanguage(content, config, "typescript")

			expect(imports.some((imp) => imp.modulePath === "./module")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "../utils")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "./other")).toBe(true)
		})

		it("should extract Python imports", () => {
			const content = `
import os
import sys
from collections import defaultdict
from . import local_module
			`
			const config = getLanguageConfig("python")!
			const imports = extractImportsForLanguage(content, config, "python")

			expect(imports.some((imp) => imp.modulePath === "os")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "sys")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "collections")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === ".")).toBe(true)
		})

		it("should extract Go imports including block imports", () => {
			const content = `
import "fmt"
import (
    "os"
    "strings"
    "github.com/user/pkg"
)
			`
			const config = getLanguageConfig("go")!
			const imports = extractImportsForLanguage(content, config, "go")

			expect(imports.some((imp) => imp.modulePath === "fmt")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "os")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "strings")).toBe(true)
			expect(imports.some((imp) => imp.modulePath === "github.com/user/pkg")).toBe(true)
		})

		it("should deduplicate imports", () => {
			const content = `
import { x } from './module';
import { y } from './module';
			`
			const config = getLanguageConfig("typescript")!
			const imports = extractImportsForLanguage(content, config, "typescript")

			const moduleImports = imports.filter((imp) => imp.modulePath === "./module")
			expect(moduleImports).toHaveLength(1)
		})
	})

	describe("collectFilesInDir", () => {
		it("should collect files with matching extensions", () => {
			readdirSyncMock.mockReturnValueOnce([
				{ name: "file1.ts", isFile: () => true },
				{ name: "file2.js", isFile: () => true },
				{ name: "README.md", isFile: () => true },
				{ name: "dir", isFile: () => false },
			] as any)

			const result = collectFilesInDir("/project/src", [".ts", ".js"], 10)
			expect(result).toHaveLength(2)
			expect(result.some((f) => f.includes("file1.ts"))).toBe(true)
			expect(result.some((f) => f.includes("file2.js"))).toBe(true)
		})

		it("should respect maxFiles limit", () => {
			readdirSyncMock.mockReturnValueOnce([
				{ name: "file1.ts", isFile: () => true },
				{ name: "file2.ts", isFile: () => true },
				{ name: "file3.ts", isFile: () => true },
			] as any)

			const result = collectFilesInDir("/project/src", [".ts"], 2)
			expect(result).toHaveLength(2)
		})

		it("should handle directory read errors", () => {
			readdirSyncMock.mockImplementationOnce(() => {
				throw new Error("Permission denied")
			})

			const result = collectFilesInDir("/project/src", [".ts"], 10)
			expect(result).toEqual([])
		})
	})

	describe("extractFileContext", () => {
		it("should extract definitions from file", () => {
			readFileSyncMock.mockReturnValueOnce(`
export class MyClass {
    myMethod() {}
}
export function helper() {}
			`)

			const config = getLanguageConfig("typescript")!
			const result = extractFileContext("/project/src/file.ts", "./file", "/project", config)

			expect(result).not.toBeNull()
			expect(result!.definitions.length).toBeGreaterThan(0)
			expect(result!.relPath).toBe("src/file.ts")
		})

		it("should return null for files with no definitions", () => {
			readFileSyncMock.mockReturnValueOnce(`// Just a comment\nconst x = 1;`)

			const config = getLanguageConfig("typescript")!
			const result = extractFileContext("/project/src/file.ts", "./file", "/project", config)
			expect(result).toBeNull()
		})

		it("should return null when file cannot be read", () => {
			readFileSyncMock.mockImplementationOnce(() => {
				throw new Error("File not found")
			})

			const config = getLanguageConfig("typescript")!
			const result = extractFileContext("/project/src/missing.ts", "./missing", "/project", config)
			expect(result).toBeNull()
		})
	})

	describe("formatResolvedContext", () => {
		it("should format resolved context", () => {
			const contexts = [
				{
					filePath: "/project/src/file.ts",
					relPath: "src/file.ts",
					importPath: "./file",
					definitions: [
						{ kind: "class", name: "MyClass", signature: "export class MyClass {}", line: 1 },
						{ kind: "func", name: "helper", signature: "export function helper() {}", line: 2 },
					],
				},
			]

			const result = formatResolvedContext(contexts)
			expect(result).toContain("src/file.ts")
			expect(result).toContain("MyClass")
			expect(result).toContain("helper")
			expect(result).toContain("./file")
		})

		it("should limit total definitions", () => {
			const contexts = Array.from({ length: 5 }, (_, i) => ({
				filePath: `/project/src/file${i}.ts`,
				relPath: `src/file${i}.ts`,
				importPath: `./file${i}`,
				definitions: Array.from({ length: 30 }, (_, j) => ({
					kind: "func",
					name: `func${j}`,
					signature: `function func${j}() {}`,
					line: j + 1,
				})),
			}))

			const result = formatResolvedContext(contexts)
			// Should be limited to MAX_TOTAL_DEFS (80)
			const lines = result.split("\n").filter((line) => line.includes("func"))
			expect(lines.length).toBeLessThanOrEqual(80)
		})
	})

	describe("LANGUAGE_DISPLAY_NAMES", () => {
		it("should have display names for all supported languages", () => {
			expect(LANGUAGE_DISPLAY_NAMES["typescript"]).toBe("TypeScript")
			expect(LANGUAGE_DISPLAY_NAMES["javascript"]).toBe("JavaScript")
			expect(LANGUAGE_DISPLAY_NAMES["python"]).toBe("Python")
			expect(LANGUAGE_DISPLAY_NAMES["java"]).toBe("Java")
			expect(LANGUAGE_DISPLAY_NAMES["cpp"]).toBe("C/C++")
			expect(LANGUAGE_DISPLAY_NAMES["go"]).toBe("Go")
			expect(LANGUAGE_DISPLAY_NAMES["rust"]).toBe("Rust")
		})
	})
})
