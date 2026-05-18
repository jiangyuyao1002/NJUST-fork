import { describe, expect, it } from "vitest"

import type { ApiHandler } from "../../types"
import { ProviderRegistry, createProviderRegistry, type ProviderFactory } from "../ProviderRegistry"

const fakeHandler = {} as ApiHandler
const fakeFactory: ProviderFactory = () => fakeHandler

describe("ProviderRegistry", () => {
	it("creates handlers only through registered factories", () => {
		const registry = new ProviderRegistry()
		registry.register("anthropic", fakeFactory, "native")

		expect(registry.createHandler({ apiProvider: "anthropic" })).toBe(fakeHandler)
		expect(registry.getTokenCountingStrategy("anthropic")).toBe("native")
	})

	it("injects shared dependencies into provider options", () => {
		const toolCallParser = {
			processFinishReason: () => [],
			clearRawChunkState: () => undefined,
			clearAllStreamingToolCalls: () => undefined,
		}
		const registry = new ProviderRegistry({ toolCallParser })
		let injectedParser: unknown

		registry.register("anthropic", (options) => {
			injectedParser = options.toolCallParser
			return fakeHandler
		})

		expect(registry.createHandler({ apiProvider: "anthropic" })).toBe(fakeHandler)
		expect(injectedParser).toBe(toolCallParser)
	})

	it("rejects unknown providers instead of falling back", () => {
		const registry = new ProviderRegistry()

		expect(() => registry.createHandler({ apiProvider: "anthropic" })).toThrow(
			'API provider "anthropic" is not registered',
		)
	})

	it("guards duplicate registrations unless override is explicit", () => {
		const registry = new ProviderRegistry()
		const replacement = {} as ApiHandler

		registry.register("anthropic", fakeFactory)
		expect(() => registry.register("anthropic", () => replacement)).toThrow(
			'Provider "anthropic" is already registered',
		)

		registry.register("anthropic", () => replacement, { override: true, tokenCountingStrategy: "estimated" })
		expect(registry.createHandler({ apiProvider: "anthropic" })).toBe(replacement)
		expect(registry.get("anthropic")?.tokenCountingStrategy).toBe("estimated")
		expect(registry.has("anthropic")).toBe(true)
		expect(registry.size()).toBe(1)
	})

	it("creates isolated registries for tests and custom wiring", () => {
		const first = createProviderRegistry()
		const second = createProviderRegistry()

		first.register("anthropic", fakeFactory)

		expect(first.has("anthropic")).toBe(true)
		expect(second.has("anthropic")).toBe(false)
	})
})
