import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

vi.mock("../../../shared/logger", () => ({
	logger: {
		warn: vi.fn(),
	},
}))

import { DualSchemaAdapter, type JSONSchema } from "../DualSchemaAdapter"

describe("DualSchemaAdapter", () => {
	it("returns explicit JSON schema before zod schema conversion", async () => {
		const jsonSchema: JSONSchema = {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		}
		const adapter = new DualSchemaAdapter(z.object({ ignored: z.string() }), jsonSchema)

		expect(adapter.getZodSchema()).toBeDefined()
		await expect(adapter.getJSONSchema()).resolves.toBe(jsonSchema)
		expect(adapter.hasSchema()).toBe(true)
	})

	it("converts zod schema to JSON schema and caches the result", async () => {
		const adapter = new DualSchemaAdapter(z.object({ path: z.string() }))

		const first = await adapter.getJSONSchema()
		const second = await adapter.getJSONSchema()

		expect(first).toBeDefined()
		expect(second).toBe(first)
		expect(adapter.hasSchema()).toBe(true)
	})

	it("returns undefined when no schema exists", async () => {
		const adapter = new DualSchemaAdapter()

		expect(adapter.getZodSchema()).toBeUndefined()
		await expect(adapter.getJSONSchema()).resolves.toBeUndefined()
		expect(adapter.hasSchema()).toBe(false)
	})
})
