import { describe, it, expect } from "vitest"
import { providerFetcherMap } from "../providerFetcherMap"
import { providerNames } from "@njust-ai-cj/types"

describe("providerFetcherMap", () => {
	it("has an entry for every ProviderName", () => {
		for (const name of providerNames) {
			expect(providerFetcherMap[name], `Missing entry for provider: ${name}`).toBeDefined()
		}
	})

	it("only contains valid FetcherKind values", () => {
		const validKinds = new Set(["openai-compatible", "anthropic", "gemini", "existing", "fallback-only"])
		for (const [name, kind] of Object.entries(providerFetcherMap)) {
			expect(validKinds.has(kind), `${name} has invalid kind: ${kind}`).toBe(true)
		}
	})

	it("maps the 10 target providers to non-fallback fetchers", () => {
		const targets: Record<string, string> = {
			openai: "openai-compatible",
			mistral: "openai-compatible",
			xai: "openai-compatible",
			qwen: "openai-compatible",
			moonshot: "openai-compatible",
			glm: "openai-compatible",
			minimax: "openai-compatible",
			deepseek: "openai-compatible",
			anthropic: "anthropic",
			gemini: "gemini",
		}

		for (const [name, expectedKind] of Object.entries(targets)) {
			expect(providerFetcherMap[name as keyof typeof providerFetcherMap]).toBe(expectedKind)
		}
	})
})
