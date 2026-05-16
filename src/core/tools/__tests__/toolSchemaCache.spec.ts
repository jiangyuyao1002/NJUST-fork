import { beforeEach, describe, expect, it } from "vitest"

import { globalToolSchemaCache, ToolSchemaCache, type CachedToolSchema } from "../toolSchemaCache"

function cached(name: string, hash = `${name}-hash`): CachedToolSchema {
	return {
		name,
		hash,
		schema: {
			type: "function",
			function: {
				name,
				description: `${name} description`,
				parameters: { type: "object", properties: {} },
			},
		},
	}
}

describe("ToolSchemaCache", () => {
	beforeEach(() => {
		globalToolSchemaCache.clear()
	})

	it("returns null for missing tools", () => {
		const cache = new ToolSchemaCache()

		expect(cache.get("read_file")).toBeNull()
		expect(cache.size).toBe(0)
	})

	it("stores and returns cached schemas", () => {
		const cache = new ToolSchemaCache()
		const schema = cached("read_file")

		cache.set("read_file", schema)

		expect(cache.get("read_file")).toBe(schema)
		expect(cache.getAllTools()).toEqual([schema.schema])
		expect(cache.size).toBe(1)
	})

	it("keeps cache when config hash is unchanged", () => {
		const cache = new ToolSchemaCache()
		cache.set("read_file", cached("read_file"))

		expect(cache.validateConfig("a")).toBe(true)
		expect(cache.validateConfig("a")).toBe(true)
		expect(cache.size).toBe(1)
	})

	it("clears cache when config hash changes", () => {
		const cache = new ToolSchemaCache()
		cache.validateConfig("a")
		cache.set("read_file", cached("read_file"))

		expect(cache.validateConfig("b")).toBe(false)
		expect(cache.size).toBe(0)
	})

	it("clear resets cache and config hash", () => {
		const cache = new ToolSchemaCache()
		cache.validateConfig("a")
		cache.set("read_file", cached("read_file"))

		cache.clear()

		expect(cache.size).toBe(0)
		expect(cache.validateConfig("b")).toBe(true)
	})

	it("exports isolated global cache instance", () => {
		globalToolSchemaCache.set("read_file", cached("read_file"))

		expect(globalToolSchemaCache.size).toBe(1)
	})
})
