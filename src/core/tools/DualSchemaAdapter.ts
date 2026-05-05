import { type ZodSchema } from "zod"

/**
 * A standard JSON Schema representation.
 * Used for MCP interoperability and direct schema specification.
 */
export type JSONSchema = {
	type: string
	properties?: Record<string, unknown>
	required?: string[]
	[key: string]: unknown
}

/**
 * Adapter that unifies Zod schemas and plain JSON Schema objects.
 *
 * Tools can define their input schemas using either Zod (for runtime validation)
 * or plain JSON Schema (for MCP interop). DualSchemaAdapter provides a single
 * interface that exposes both formats:
 *
 * - Zod schema → used internally for validation in BaseTool.handle()
 * - JSON Schema → used by MCP tool registration and prompt generation
 *
 * When only a Zod schema is provided, the JSON Schema is lazily derived using
 * zod-to-json-schema. When only a JSON Schema is provided, no Zod schema is
 * available (MCP tools skip Zod validation).
 */
export class DualSchemaAdapter {
	private cachedJsonSchema: JSONSchema | undefined

	constructor(
		private zodSchema?: ZodSchema,
		private explicitJsonSchema?: JSONSchema,
	) {}

	/**
	 * Get the Zod schema (for runtime validation).
	 * Returns undefined if only a JSON Schema was provided.
	 */
	getZodSchema(): ZodSchema | undefined {
		return this.zodSchema
	}

	/**
	 * Get the JSON Schema representation.
	 * Priority:
	 *   1. Explicit JSON Schema (e.g., from MCP server)
	 *   2. Auto-converted from Zod schema
	 *   3. undefined
	 */
	getJSONSchema(): JSONSchema | undefined {
		if (this.explicitJsonSchema) {
			return this.explicitJsonSchema
		}
		if (this.zodSchema && !this.cachedJsonSchema) {
			try {
				// Lazy import to avoid bundling zod-to-json-schema when not needed
				 
				const { zodToJsonSchema } = require("zod-to-json-schema")
				this.cachedJsonSchema = zodToJsonSchema(this.zodSchema, {
					target: "openApi3",
				}) as JSONSchema
			} catch {
				// zod-to-json-schema not installed — fall back to undefined
				console.warn("[DualSchemaAdapter] zod-to-json-schema not available; JSON Schema conversion skipped.")
				return undefined
			}
		}
		return this.cachedJsonSchema
	}

	/**
	 * Whether this adapter has any schema definition.
	 */
	hasSchema(): boolean {
		return this.zodSchema !== undefined || this.explicitJsonSchema !== undefined
	}
}
