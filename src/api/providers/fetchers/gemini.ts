import type { DynamicModelRecord, ListModelsOptions } from "../modelTypes"

export async function fetchGeminiModels(
	options: ListModelsOptions = {},
): Promise<DynamicModelRecord> {
	const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
	if (!apiKey) {
		throw new Error("Missing Gemini API key")
	}

	const baseUrl =
		options.baseUrl || "https://generativelanguage.googleapis.com/v1beta"

	const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`)
	url.searchParams.set("key", apiKey)

	const res = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
		},
	})

	if (!res.ok) {
		const body = await res.text().catch(() => "")
		throw new Error(`Failed to fetch Gemini models: ${res.status} ${body}`)
	}

	const json = await res.json()
	const list = Array.isArray(json.models) ? json.models : []

	const models: DynamicModelRecord = {}

	for (const item of list) {
		const rawName: string | undefined = item.name
		if (!rawName) continue

		const id = rawName.replace(/^models\//, "")

		const methods: string[] = Array.isArray(item.supportedGenerationMethods)
			? item.supportedGenerationMethods
			: []

		if (!methods.includes("generateContent")) {
			continue
		}

		models[id] = {
			maxTokens: item.outputTokenLimit ?? undefined,
			contextWindow: item.inputTokenLimit ?? 1_000_000,
			supportsPromptCache: false,
			source: "api",
		}
	}

	return models
}
