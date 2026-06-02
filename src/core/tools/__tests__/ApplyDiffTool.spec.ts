import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(function () {
			return {
				onDidCreate: vi.fn(),
				onDidChange: vi.fn(),
				onDidDelete: vi.fn(),
				dispose: vi.fn(),
			}
		}),
	},
	RelativePattern: vi.fn(),
}))

import { ApplyDiffTool, applyDiffTool } from "../ApplyDiffTool"

describe("ApplyDiffTool", () => {
	it("has name apply_diff", () => {
		const tool = new ApplyDiffTool()
		expect(tool.name).toBe("apply_diff")
	})

	it("requires checkpoint", () => {
		const tool = new ApplyDiffTool()
		expect(tool.requiresCheckpoint).toBe(true)
	})

	it("interrupt behavior is block", () => {
		const tool = new ApplyDiffTool()
		expect(tool.interruptBehavior()).toBe("block")
	})

	it("userFacingName returns Apply Diff", () => {
		const tool = new ApplyDiffTool()
		expect(tool.userFacingName()).toBe("Apply Diff")
	})

	it("exports singleton applyDiffTool", () => {
		expect(applyDiffTool).toBeInstanceOf(ApplyDiffTool)
		expect(applyDiffTool.name).toBe("apply_diff")
	})
})
