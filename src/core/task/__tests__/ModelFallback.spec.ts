import { describe, expect, it } from "vitest"

import { ModelFallbackManager } from "../ModelFallback"

describe("ModelFallbackManager", () => {
	it("starts on the primary model with empty fallback state", () => {
		const manager = new ModelFallbackManager("primary", { fallbackModels: ["backup"] })

		expect(manager.getCurrentModel()).toBe("primary")
		expect(manager.isInFallbackMode()).toBe(false)
		expect(manager.getState()).toEqual({
			currentModelIndex: 0,
			consecutiveFailures: 0,
			totalFallbacks: 0,
			originalModel: "primary",
			isInFallback: false,
		})
	})

	it("keeps current model before failure threshold", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 3,
			fallbackModels: ["backup"],
		})

		const result = manager.reportFailure(new Error("rate limited"))

		expect(result.nextModel).toBe("primary")
		expect(result.shouldNotifyUser).toBe(false)
		expect(result.reason).toContain("failed 1/3 times")
		expect(manager.getState().consecutiveFailures).toBe(1)
	})

	it("falls back when failure threshold is reached", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 2,
			fallbackModels: ["backup"],
		})

		manager.reportFailure(new Error("first"))
		const result = manager.reportFailure(new Error("second"))

		expect(result.nextModel).toBe("backup")
		expect(result.shouldNotifyUser).toBe(true)
		expect(result.reason).toContain('Falling back to "backup"')
		expect(manager.getCurrentModel()).toBe("backup")
		expect(manager.getState()).toMatchObject({
			currentModelIndex: 1,
			consecutiveFailures: 0,
			totalFallbacks: 1,
			isInFallback: true,
		})
	})

	it("respects notifyUser=false when fallback occurs", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
			fallbackModels: ["backup"],
			notifyUser: false,
		})

		const result = manager.reportFailure(new Error("boom"))

		expect(result.nextModel).toBe("backup")
		expect(result.shouldNotifyUser).toBe(false)
	})

	it("walks through multiple fallback models in order", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
			fallbackModels: ["backup", "small"],
		})

		expect(manager.reportFailure(new Error("primary failed")).nextModel).toBe("backup")
		expect(manager.reportFailure(new Error("backup failed")).nextModel).toBe("small")

		expect(manager.getCurrentModel()).toBe("small")
		expect(manager.getState().totalFallbacks).toBe(2)
	})

	it("returns null when every model is exhausted", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
			fallbackModels: ["backup"],
		})

		manager.reportFailure(new Error("primary failed"))
		const result = manager.reportFailure(new Error("backup failed"))

		expect(result.nextModel).toBeNull()
		expect(result.shouldNotifyUser).toBe(true)
		expect(result.reason).toContain("All models exhausted")
		expect(manager.getCurrentModel()).toBe("backup")
	})

	it("resets failure count after success without leaving fallback mode", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
			fallbackModels: ["backup"],
		})
		manager.reportFailure(new Error("primary failed"))
		manager.reportFailure(new Error("backup failed once"))

		manager.reportSuccess()

		expect(manager.getCurrentModel()).toBe("backup")
		expect(manager.isInFallbackMode()).toBe(true)
		expect(manager.getState().consecutiveFailures).toBe(0)
	})

	it("resets back to primary model and clears fallback counters", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
			fallbackModels: ["backup"],
		})
		manager.reportFailure(new Error("primary failed"))

		manager.reset()

		expect(manager.getCurrentModel()).toBe("primary")
		expect(manager.getState()).toMatchObject({
			currentModelIndex: 0,
			consecutiveFailures: 0,
			totalFallbacks: 0,
			originalModel: "primary",
			isInFallback: false,
		})
	})

	it("exhausts immediately when no fallback model is configured", () => {
		const manager = new ModelFallbackManager("primary", {
			maxFailuresBeforeFallback: 1,
		})

		const result = manager.reportFailure(new Error("primary failed"))

		expect(result.nextModel).toBeNull()
		expect(result.shouldNotifyUser).toBe(true)
		expect(manager.isInFallbackMode()).toBe(false)
	})

	it("returns state copies instead of mutable internal state", () => {
		const manager = new ModelFallbackManager("primary")
		const state = manager.getState() as any

		state.currentModelIndex = 99
		state.originalModel = "mutated"

		expect(manager.getCurrentModel()).toBe("primary")
		expect(manager.getState().originalModel).toBe("primary")
	})
})
