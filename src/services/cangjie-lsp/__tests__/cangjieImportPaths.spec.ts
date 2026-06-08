import { describe, it, expect } from "vitest"

import { extractCangjieImportPackagePrefixes, posixPathMatchesImportPackage } from "../cangjieImportPaths"

describe("extractCangjieImportPackagePrefixes", () => {
	it("extracts wildcard import (import x.y.*)", () => {
		const result = extractCangjieImportPackagePrefixes("import std.io.*\nimport std.collection.*")
		expect(result).toEqual(["std.io", "std.collection"])
	})

	it("extracts brace import (import x.y { ... })", () => {
		const result = extractCangjieImportPackagePrefixes("import std.collection { ArrayList, HashMap }")
		expect(result).toEqual(["std.collection"])
	})

	it("strips trailing dots from brace imports", () => {
		const result = extractCangjieImportPackagePrefixes("import std.collection. { ArrayList }")
		expect(result).toEqual(["std.collection"])
	})

	it("extracts from-import (from x.y import ...)", () => {
		const result = extractCangjieImportPackagePrefixes("from std.io import println\nfrom std.math import abs")
		expect(result).toEqual(["std.io", "std.math"])
	})

	it("deduplicates identical prefixes", () => {
		const result = extractCangjieImportPackagePrefixes(
			"import std.io.*\nimport std.io.*\nfrom std.io import println",
		)
		expect(result).toEqual(["std.io"])
	})

	it("returns empty array for no imports", () => {
		const result = extractCangjieImportPackagePrefixes('func main() { println("hello") }')
		expect(result).toEqual([])
	})

	it("handles mixed import styles", () => {
		const result = extractCangjieImportPackagePrefixes(
			"import std.io.*\nimport std.collection { ArrayList }\nfrom std.math import abs",
		)
		expect(result).toEqual(["std.io", "std.collection", "std.math"])
	})

	it("handles empty input", () => {
		expect(extractCangjieImportPackagePrefixes("")).toEqual([])
	})

	it("ignores indented lines that don't match", () => {
		const result = extractCangjieImportPackagePrefixes("// import std.io.*\n  x = 1")
		expect(result).toEqual([])
	})
})

describe("posixPathMatchesImportPackage", () => {
	it("matches exact path", () => {
		expect(posixPathMatchesImportPackage("std/io/file.cj", "std.io")).toBe(true)
	})

	it("matches path with prefix directory", () => {
		expect(posixPathMatchesImportPackage("src/std/io/file.cj", "std.io")).toBe(true)
	})

	it("matches path with subdirectory", () => {
		expect(posixPathMatchesImportPackage("std/io/sub/file.cj", "std.io")).toBe(true)
	})

	it("matches path ending with package", () => {
		expect(posixPathMatchesImportPackage("project/src/std/io", "std.io")).toBe(true)
	})

	it("rejects substring false positive (utils vs my_utils)", () => {
		expect(posixPathMatchesImportPackage("my_utils/file.cj", "utils")).toBe(false)
	})

	it("rejects empty needle", () => {
		expect(posixPathMatchesImportPackage("any/path.cj", "")).toBe(false)
	})

	it("normalizes backslashes", () => {
		expect(posixPathMatchesImportPackage("std\\io\\file.cj", "std.io")).toBe(true)
	})

	it("strips leading slashes", () => {
		expect(posixPathMatchesImportPackage("/std/io/file.cj", "std.io")).toBe(true)
	})

	it("rejects non-matching path", () => {
		expect(posixPathMatchesImportPackage("other/module/file.cj", "std.io")).toBe(false)
	})
})
