/**
 * Shared Zod helpers for tool parameter validation.
 * Models often emit numeric/boolean fields as strings; legacy `params` may still be stringy
 * even after `mergeToolParamsForValidation` preserves native `boolean`/`number`.
 */
import { z } from "zod"

/** "true" / "false" strings vs real booleans. */
export const optionalBooleanCoerced = z
	.union([z.boolean(), z.literal("true").transform(() => true), z.literal("false").transform(() => false)])
	.optional()

function preprocessOptionalNumber(val: unknown): unknown {
	if (val === undefined || val === null || val === "") {
		return undefined
	}
	if (typeof val === "number" && Number.isFinite(val)) {
		return val
	}
	if (typeof val === "string") {
		const t = val.trim()
		if (t === "") return undefined
		if (/^-?\d+(\.\d+)?$/.test(t)) {
			return Number(t)
		}
	}
	return val
}

/** Timeout seconds, maxLength-style numbers. Allows null. */
export const optionalNumberOrNumericString = z.preprocess(
	preprocessOptionalNumber,
	z.number().finite().optional().nullable(),
)

/** 1-based line numbers, counts (coerce `"14"` → 14). */
export const optionalPositiveIntCoerced = z.preprocess((val) => {
	if (val === undefined || val === null || val === "") return undefined
	if (typeof val === "number" && Number.isFinite(val)) return Math.trunc(val)
	if (typeof val === "string" && /^\d+$/.test(val.trim())) return parseInt(val.trim(), 10)
	return val
}, z.number().int().positive().optional())
