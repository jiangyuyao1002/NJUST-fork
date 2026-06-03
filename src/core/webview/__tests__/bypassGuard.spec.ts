import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock vscode before importing the module under test
vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn(),
	},
}))

// Mock i18n to return the key itself
vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import * as vscode from "vscode"
import { confirmBypassTransition } from "../bypassGuard"
import type { GlobalState } from "@njust-ai/types"

/** Helper: create a BypassGuardDeps with all keys set to the given value */
function makeDeps(allTrue: boolean) {
	const store = new Map<string, unknown>()
	if (allTrue) {
		store.set("autoApprovalEnabled", true)
		store.set("alwaysAllowExecute", true)
		store.set("alwaysAllowWrite", true)
		store.set("alwaysAllowWriteOutsideWorkspace", true)
		store.set("alwaysAllowWriteProtected", true)
		store.set("alwaysAllowReadOnly", true)
		store.set("alwaysAllowReadOnlyOutsideWorkspace", true)
		store.set("alwaysAllowMcp", true)
		store.set("alwaysAllowModeSwitch", true)
		store.set("alwaysAllowSubtasks", true)
	}
	return {
		getValue: vi.fn(<K extends keyof GlobalState>(key: K) => store.get(key) as GlobalState[K] | undefined),
		setValue: vi.fn(<K extends keyof GlobalState>(key: K, value: GlobalState[K]) => {
			store.set(key, value)
			return Promise.resolve()
		}),
		_store: store,
	}
}

describe("bypassGuard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("进入 bypass 时弹出确认对话框", async () => {
		const deps = makeDeps(true)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("chat:bypassMode.confirmAction" as never)

		const result = await confirmBypassTransition(deps)

		expect(result).toBe(true)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"chat:bypassMode.confirmTitle",
			expect.objectContaining({ modal: true }),
			"chat:bypassMode.confirmAction",
		)
		// 用户确认后不应回退设置
		expect(deps.setValue).not.toHaveBeenCalled()
	})

	it("用户取消时自动回退所有 bypass 设置", async () => {
		const deps = makeDeps(true)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never)

		const result = await confirmBypassTransition(deps)

		expect(result).toBe(false)
		// 所有 10 个 bypass key 都应被设为 false
		expect(deps.setValue).toHaveBeenCalledTimes(10)
		const revertedKeys = deps.setValue.mock.calls.map((call) => call[0])
		expect(revertedKeys).toContain("autoApprovalEnabled")
		expect(revertedKeys).toContain("alwaysAllowExecute")
		expect(revertedKeys).toContain("alwaysAllowWrite")
		expect(revertedKeys).toContain("alwaysAllowMcp")
		expect(revertedKeys).toContain("alwaysAllowSubtasks")
		// 所有回退值都是 false
		for (const call of deps.setValue.mock.calls) {
			expect(call[1]).toBe(false)
		}
	})

	it("非 bypass 模式时不弹对话框", async () => {
		const deps = makeDeps(false) // 所有设置都是 false → default 模式

		const result = await confirmBypassTransition(deps)

		expect(result).toBe(true)
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(deps.setValue).not.toHaveBeenCalled()
	})
})
