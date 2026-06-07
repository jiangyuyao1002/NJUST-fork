import { beforeEach, describe, expect, it, vi } from "vitest"

const { delayMock, getModeBySlugMock, toolErrorMock, visibleTextEditorsMock, showInfoMessageMock } = vi.hoisted(() => ({
	delayMock: vi.fn(),
	getModeBySlugMock: vi.fn(),
	toolErrorMock: vi.fn((msg: string) => `Error: ${msg}`),
	visibleTextEditorsMock: vi.fn(() => []),
	showInfoMessageMock: vi.fn(),
}))

vi.mock("delay", () => ({
	default: delayMock,
}))

vi.mock("vscode", () => ({
	window: {
		get visibleTextEditors() {
			return visibleTextEditorsMock()
		},
		showInformationMessage: showInfoMessageMock,
	},
}))

vi.mock("../../../shared/modes", () => ({
	getModeBySlug: getModeBySlugMock,
	defaultModeSlug: "code",
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: toolErrorMock,
	},
}))

import { switchModeTool } from "../SwitchModeTool"

function createTask(overrides: Record<string, unknown> = {}) {
	const provider = {
		getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [], showRooIgnoredFiles: false }),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
	}
	return {
		cwd: "/workspace",
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		providerRef: { deref: () => provider },
		ask: vi.fn().mockResolvedValue(true),
		...overrides,
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	}
}

describe("SwitchModeTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		getModeBySlugMock.mockImplementation((slug: string) => {
			const modes: Record<string, { slug: string; name: string }> = {
				code: { slug: "code", name: "Code" },
				architect: { slug: "architect", name: "Architect" },
				cangjie: { slug: "cangjie", name: "Cangjie Dev" },
			}
			return modes[slug] ?? undefined
		})
		delayMock.mockResolvedValue(undefined)
		visibleTextEditorsMock.mockReturnValue([])
	})

	describe("execute", () => {
		it("returns error for invalid mode", async () => {
			getModeBySlugMock.mockReturnValue(undefined)
			const task = createTask()
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "invalid-mode" }, task, callbacks as any)

			expect(task.recordToolError).toHaveBeenCalledWith("switch_mode")
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Invalid mode: invalid-mode"))
		})

		it("returns message when already in requested mode", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "code" }, task, callbacks as any)

			expect(task.recordToolError).toHaveBeenCalledWith("switch_mode")
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Already in Code mode"))
		})

		it("switches mode successfully", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "architect" }, task, callbacks as any)

			const provider = task.providerRef.deref()
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect")
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Successfully switched from Code mode to Architect mode"),
			)
			expect(delayMock).toHaveBeenCalledWith(500)
			expect(task.consecutiveMistakeCount).toBe(0)
		})

		it("includes reason in success message when provided", async () => {
			const task = createTask()
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "architect", reason: "need to plan" }, task, callbacks as any)

			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("because: need to plan"))
		})

		it("does not switch mode when approval is denied", async () => {
			const callbacks = createCallbacks()
			callbacks.askApproval.mockResolvedValue(false)
			const task = createTask()

			await switchModeTool.execute({ mode_slug: "architect" }, task, callbacks as any)

			const provider = task.providerRef.deref()
			expect(provider.handleModeSwitch).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		})

		it("shows info message when switching from cangjie with open .cj files", async () => {
			visibleTextEditorsMock.mockReturnValue([
				{ document: { fileName: "main.cj" } },
				{ document: { fileName: "utils.cj" } },
			])
			const provider = {
				getState: vi.fn().mockResolvedValue({ mode: "cangjie", customModes: [] }),
				handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			}
			const task = createTask({
				providerRef: { deref: () => provider },
			})
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "code" }, task, callbacks as any)

			expect(showInfoMessageMock).toHaveBeenCalledWith(expect.stringContaining("cangjie_mode_left_with_files"))
		})

		it("does not show info message when switching to cangjie", async () => {
			visibleTextEditorsMock.mockReturnValue([{ document: { fileName: "main.cj" } }])
			const provider = {
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
				handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			}
			const task = createTask({
				providerRef: { deref: () => provider },
			})
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "architect" }, task, callbacks as any)

			expect(showInfoMessageMock).not.toHaveBeenCalled()
		})

		it("delegates errors to handleError", async () => {
			const provider = {
				getState: vi.fn().mockRejectedValue(new Error("state error")),
				handleModeSwitch: vi.fn(),
			}
			const task = createTask({
				providerRef: { deref: () => provider },
			})
			const callbacks = createCallbacks()

			await switchModeTool.execute({ mode_slug: "architect" }, task, callbacks as any)

			expect(callbacks.handleError).toHaveBeenCalledWith(
				"switching mode",
				expect.objectContaining({ message: "state error" }),
			)
		})
	})

	describe("handlePartial", () => {
		it("asks with partial tool message", async () => {
			const task = createTask()

			await switchModeTool.handlePartial(task, {
				params: { mode_slug: "architect", reason: "planning" },
				partial: true,
			} as any)

			expect(task.ask).toHaveBeenCalledWith("tool", expect.stringContaining("switchMode"), true)
		})
	})
})
