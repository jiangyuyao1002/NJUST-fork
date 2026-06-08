import { describe, it, expect, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: actual,
	}
})

import { extractWhereConstraintsFromCorpus, mergeStdlibConstraintHintsFromCorpus } from "../stdlibConstraintHints"

describe("extractWhereConstraintsFromCorpus", () => {
	it("returns empty for non-existent directory", () => {
		const result = extractWhereConstraintsFromCorpus("/nonexistent/path")
		expect(result).toEqual({})
	})

	it("extracts where constraints from markdown files", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-constraints-"))
		const collectionDir = path.join(tmpDir, "libs/std/collection")
		fs.mkdirSync(collectionDir, { recursive: true })
		fs.writeFileSync(
			path.join(collectionDir, "ArrayList.md"),
			"class ArrayList<T> where T <: Equatable<T> {\n  // ...\n}\n",
		)
		fs.writeFileSync(
			path.join(collectionDir, "HashMap.md"),
			"interface HashMap<K, V> where K <: Hashable {\n  // ...\n}\n",
		)

		try {
			const result = extractWhereConstraintsFromCorpus(tmpDir)
			expect(result["std.collection"]).toBeDefined()
			expect(result["std.collection"]).toContain("Equatable")
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		}
	})

	it("skips files without where/<: constraints", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-no-constraint-"))
		const coreDir = path.join(tmpDir, "libs/std/core")
		fs.mkdirSync(coreDir, { recursive: true })
		fs.writeFileSync(path.join(coreDir, "Empty.md"), "# Empty\nNo constraints here.\n")

		try {
			const result = extractWhereConstraintsFromCorpus(tmpDir)
			expect(result["std.core"]).toBeUndefined()
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
		}
	})
})

describe("mergeStdlibConstraintHintsFromCorpus", () => {
	it("returns base hints when corpus has no constraints", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-merge-"))
		const globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), "cj-storage-"))
		try {
			const result = mergeStdlibConstraintHintsFromCorpus({ "std.core": "base hint" }, tmpDir, globalStorage)
			expect(result["std.core"]).toBe("base hint")
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
			fs.rmSync(globalStorage, { recursive: true, force: true })
		}
	})

	it("merges corpus constraints with base hints", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-merge2-"))
		const globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), "cj-storage2-"))
		const collectionDir = path.join(tmpDir, "libs/std/collection")
		fs.mkdirSync(collectionDir, { recursive: true })
		fs.writeFileSync(path.join(collectionDir, "List.md"), "where T <: Comparable<T>\n")

		try {
			const result = mergeStdlibConstraintHintsFromCorpus({ "std.core": "base hint" }, tmpDir, globalStorage)
			expect(result["std.core"]).toBe("base hint")
			expect(result["std.collection"]).toBeDefined()
			expect(result["std.collection"]).toContain("Comparable")
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true })
			fs.rmSync(globalStorage, { recursive: true, force: true })
		}
	})
})
