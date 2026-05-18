import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn() })),
	},
}))

import { delegateParentAndOpenChildWithProvider, reopenParentFromDelegationWithProvider } from "../ClineProviderDelegation"
import { handleModeSwitchWithProvider, restoreHistoryModeAndProfileWithProvider } from "../ClineProviderModeSync"

describe("ClineProvider extraction boundaries", () => {
	it("exposes delegation helpers from the delegation module", () => {
		expect(typeof delegateParentAndOpenChildWithProvider).toBe("function")
		expect(typeof reopenParentFromDelegationWithProvider).toBe("function")
	})

	it("exposes mode/profile sync helpers from the mode sync module", () => {
		expect(typeof handleModeSwitchWithProvider).toBe("function")
		expect(typeof restoreHistoryModeAndProfileWithProvider).toBe("function")
	})
})
