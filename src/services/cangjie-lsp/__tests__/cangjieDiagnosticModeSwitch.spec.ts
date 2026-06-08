import { describe, it, expect, vi, beforeEach } from "vitest"

import { cangjieDiagnosticModeSwitch } from "../cangjieDiagnosticModeSwitch"

describe("cangjieDiagnosticModeSwitch", () => {
	beforeEach(() => {
		cangjieDiagnosticModeSwitch.clearCjlint = undefined
		cangjieDiagnosticModeSwitch.clearCjpm = undefined
	})

	it("calls clearCjlint when set", () => {
		const mockClear = vi.fn()
		cangjieDiagnosticModeSwitch.clearCjlint = mockClear
		cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()
		expect(mockClear).toHaveBeenCalledOnce()
	})

	it("calls clearCjpm when set", () => {
		const mockClear = vi.fn()
		cangjieDiagnosticModeSwitch.clearCjpm = mockClear
		cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()
		expect(mockClear).toHaveBeenCalledOnce()
	})

	it("calls both callbacks when both are set", () => {
		const mockCjlint = vi.fn()
		const mockCjpm = vi.fn()
		cangjieDiagnosticModeSwitch.clearCjlint = mockCjlint
		cangjieDiagnosticModeSwitch.clearCjpm = mockCjpm
		cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()
		expect(mockCjlint).toHaveBeenCalledOnce()
		expect(mockCjpm).toHaveBeenCalledOnce()
	})

	it("does not throw when callbacks are not set", () => {
		expect(() => cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()).not.toThrow()
	})

	it("silently ignores exceptions from clearCjlint", () => {
		cangjieDiagnosticModeSwitch.clearCjlint = vi.fn(() => {
			throw new Error("cjlint error")
		})
		const mockCjpm = vi.fn()
		cangjieDiagnosticModeSwitch.clearCjpm = mockCjpm
		expect(() => cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()).not.toThrow()
		expect(mockCjpm).toHaveBeenCalledOnce()
	})

	it("silently ignores exceptions from clearCjpm", () => {
		const mockCjlint = vi.fn()
		cangjieDiagnosticModeSwitch.clearCjlint = mockCjlint
		cangjieDiagnosticModeSwitch.clearCjpm = vi.fn(() => {
			throw new Error("cjpm error")
		})
		expect(() => cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()).not.toThrow()
		expect(mockCjlint).toHaveBeenCalledOnce()
	})
})
