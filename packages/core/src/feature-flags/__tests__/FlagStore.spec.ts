import { afterEach, describe, expect, it } from "vitest"

import { FlagStore } from "../FlagStore.js"

describe("FlagStore", () => {
	const originalFlagImageGeneration = process.env.FLAG_IMAGE_GENERATION

	afterEach(() => {
		if (originalFlagImageGeneration === undefined) {
			delete process.env.FLAG_IMAGE_GENERATION
		} else {
			process.env.FLAG_IMAGE_GENERATION = originalFlagImageGeneration
		}
	})

	it("uses explicit overrides before rollout or default values", () => {
		const store = new FlagStore(
			{
				imageGeneration: { defaultValue: false, rolloutPercent: 0 },
			},
			{
				imageGeneration: true,
			},
		)

		expect(store.isEnabled("imageGeneration")).toBe(true)
	})

	it("uses local environment overrides when explicit override is absent", () => {
		const store = new FlagStore({
			imageGeneration: { defaultValue: false },
		})

		process.env.FLAG_IMAGE_GENERATION = "true"
		expect(store.isEnabled("imageGeneration")).toBe(true)

		process.env.FLAG_IMAGE_GENERATION = "0"
		expect(store.isEnabled("imageGeneration")).toBe(false)
	})

	it("returns false for unknown flags", () => {
		const store = new FlagStore({})

		expect(store.isEnabled("missingFlag")).toBe(false)
		expect(store.getRolloutPercent("missingFlag")).toBe(100)
	})

	it("applies percentage rollout before returning the default value", () => {
		const store = new FlagStore({
			imageGeneration: { defaultValue: true, rolloutPercent: 0 },
		})

		expect(store.isEnabled("imageGeneration")).toBe(false)
		expect(store.getRolloutPercent("imageGeneration")).toBe(0)
	})

	it("reports all flags with evaluated state", () => {
		const store = new FlagStore(
			{
				imageGeneration: { defaultValue: true, rolloutPercent: 100 },
				cloudAgent: { defaultValue: false },
			},
			{
				cloudAgent: true,
			},
		)

		expect(store.getAllFlags()).toEqual({
			imageGeneration: {
				enabled: true,
				defaultValue: true,
				rolloutPercent: 100,
			},
			cloudAgent: {
				enabled: true,
				defaultValue: false,
				rolloutPercent: undefined,
			},
		})
	})
})
