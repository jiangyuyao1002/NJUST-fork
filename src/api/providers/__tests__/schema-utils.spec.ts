// npx vitest run src/api/providers/__tests__/schema-utils.spec.ts

import { describe, it, expect } from "vitest"
import { ensureAllRequired, ensureAdditionalPropertiesFalse } from "../schema-utils"

describe("schema-utils", () => {
	describe("ensureAllRequired", () => {
		it("should mark all properties as required", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
					age: { type: "number" },
				},
			}
			const result = ensureAllRequired(schema)
			expect(result.required).toEqual(["name", "age"])
		})

		it("should recursively process nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					address: {
						type: "object",
						properties: {
							city: { type: "string" },
							zip: { type: "string" },
						},
					},
				},
			}
			const result = ensureAllRequired(schema)
			expect(result.required).toEqual(["address"])
			expect(result.properties.address.required).toEqual(["city", "zip"])
		})
	})

	describe("ensureAdditionalPropertiesFalse", () => {
		it("should set additionalProperties to false on object schemas", () => {
			const schema = {
				type: "object",
				properties: {
					name: { type: "string" },
				},
			}
			const result = ensureAdditionalPropertiesFalse(schema)
			expect(result.additionalProperties).toBe(false)
		})

		it("should recursively set additionalProperties false on nested objects", () => {
			const schema = {
				type: "object",
				properties: {
					address: {
						type: "object",
						properties: {
							city: { type: "string" },
						},
					},
				},
			}
			const result = ensureAdditionalPropertiesFalse(schema)
			expect(result.additionalProperties).toBe(false)
			expect(result.properties.address.additionalProperties).toBe(false)
		})

		it("should not modify non-object schemas", () => {
			const schema = { type: "string" }
			const result = ensureAdditionalPropertiesFalse(schema)
			expect(result).toEqual({ type: "string" })
		})
	})
})
