/**
 * Shared schema processing utilities for OpenAI-compatible providers.
 * Used by openai-codex and openai-native to normalize JSON schemas.
 */

export function ensureAllRequired(schema: any): any {
	const getPrimaryType = (value: any): string | undefined =>
		Array.isArray(value?.type) ? value.type.find((t: string) => t !== "null") : value?.type

	if (!schema || typeof schema !== "object" || getPrimaryType(schema) !== "object") {
		return schema
	}

	const result = { ...schema }
	const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : [])
	if (result.additionalProperties !== false) {
		result.additionalProperties = false
	}

	if (result.properties) {
		const allKeys = Object.keys(result.properties)
		result.required = allKeys

		const newProps = { ...result.properties }
		for (const key of allKeys) {
			const prop = newProps[key]
			if (prop && !originallyRequired.has(key)) {
				const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : []
				if (types.length > 0 && !types.includes("null")) {
					newProps[key] = { ...prop, type: [...types, "null"] }
				}
			}
			const normalizedProp = newProps[key]
			const primaryType = getPrimaryType(normalizedProp)
			if (primaryType === "object") {
				newProps[key] = ensureAllRequired(normalizedProp)
			} else if (primaryType === "array" && getPrimaryType(normalizedProp.items) === "object") {
				newProps[key] = {
					...normalizedProp,
					items: ensureAllRequired(normalizedProp.items),
				}
			}
		}
		result.properties = newProps
	}

	return result
}

export function ensureAdditionalPropertiesFalse(schema: any): any {
	if (!schema || typeof schema !== "object" || schema.type !== "object") {
		return schema
	}

	const result = { ...schema }
	if (result.additionalProperties !== false) {
		result.additionalProperties = false
	}

	if (result.properties) {
		const newProps = { ...result.properties }
		for (const key of Object.keys(result.properties)) {
			const prop = newProps[key]
			if (prop && prop.type === "object") {
				newProps[key] = ensureAdditionalPropertiesFalse(prop)
			} else if (prop && prop.type === "array" && prop.items?.type === "object") {
				newProps[key] = {
					...prop,
					items: ensureAdditionalPropertiesFalse(prop.items),
				}
			}
		}
		result.properties = newProps
	}

	return result
}
