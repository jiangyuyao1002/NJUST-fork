import { vi, describe, it, expect, beforeEach } from "vitest"
import type { WebviewMessage } from "@njust-ai/types"

vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
	commands: { executeCommand: vi.fn() },
	env: { openExternal: vi.fn() },
}))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: vi.fn() }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(false) }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../../shared/modes", () => ({ defaultModeSlug: "code" }))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: () => "/mock/workspace" }))
vi.mock("../../../shared/package", () => ({ Package: { name: "njust-ai" } }))
vi.mock("../../../services/njust-ai-config/index.js", () => ({ getRooDirectoriesForCwd: () => [] }))
vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn().mockResolvedValue(undefined),
	saveLastExportPath: vi.fn(),
}))
vi.mock("../../skillsMessageHandler", () => ({
	handleRequestSkills: vi.fn(),
	handleCreateSkill: vi.fn(),
	handleDeleteSkill: vi.fn(),
	handleMoveSkill: vi.fn(),
	handleUpdateSkillModes: vi.fn(),
	handleOpenSkillFile: vi.fn(),
}))
vi.mock("../../../services/command/commands", () => ({
	getCommands: vi.fn().mockResolvedValue([]),
	getCommand: vi.fn().mockResolvedValue(null),
}))

import { registerModeHandlers } from "../../handlers/modeHandler"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("modeHandler", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		context = createMockContext()
		registerModeHandlers(router)
	})

	it("registers all expected mode handlers", () => {
		const registeredTypes = [
			"mode", "updatePrompt", "openCustomModesSettings", "openKeyboardShortcuts",
			"refreshCustomTools", "updateCustomMode", "deleteCustomMode", "exportMode",
			"importMode", "checkRulesDirectory", "requestCommands", "requestModes",
			"requestSkills", "createSkill", "deleteSkill", "moveSkill",
			"updateSkillModes", "openSkillFile", "openCommandFile", "deleteCommand",
			"createCommand", "openDebugApiHistory", "openDebugUiHistory",
		]
		for (const type of registeredTypes) {
			const handler = vi.fn()
			router.register(type, handler)
		}
	})

	it("mode handler calls provider.handleModeSwitch", async () => {
		await router.route(context, { type: "mode", text: "architect" } as WebviewMessage)

		expect(context.provider.handleModeSwitch).toHaveBeenCalledWith("architect")
	})

	it("updatePrompt saves custom prompt to global state", async () => {
		;(context.getGlobalState as any).mockReturnValue({})
		;(context.provider.getStateToPostToWebview as any).mockResolvedValue({})

		await router.route(context, {
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: "custom instructions",
		} as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("customModePrompts", { code: "custom instructions" })
	})

	it("updatePrompt posts state to webview after update", async () => {
		;(context.getGlobalState as any).mockReturnValue({})
		;(context.provider.getStateToPostToWebview as any).mockResolvedValue({})

		await router.route(context, {
			type: "updatePrompt",
			promptMode: "code",
			customPrompt: "test",
		} as any)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "state" }),
		)
	})

	it("requestModes calls provider.getModes and posts result", async () => {
		const mockModes = [{ slug: "code" }, { slug: "architect" }]
		;(context.provider.getModes as any).mockResolvedValue(mockModes)

		await router.route(context, { type: "requestModes" } as WebviewMessage)

		expect(context.provider.getModes).toHaveBeenCalledOnce()
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "modes",
			modes: mockModes,
		})
	})

	it("requestModes handles error gracefully", async () => {
		;(context.provider.getModes as any).mockRejectedValue(new Error("fail"))

		await router.route(context, { type: "requestModes" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "modes",
			modes: [],
		})
	})

	it("updateCustomMode calls customModesManager.updateCustomMode", async () => {
		const modeConfig = { slug: "custom" }
		;(context.provider.customModesManager.updateCustomMode as any).mockResolvedValue(undefined)
		;(context.provider.customModesManager.getCustomModes as any).mockReturnValue([modeConfig])

		await router.route(context, { type: "updateCustomMode", modeConfig } as any)

		expect(context.provider.customModesManager.updateCustomMode).toHaveBeenCalledWith("custom", modeConfig)
	})

	it("updateCustomMode updates global state with new modes", async () => {
		const modeConfig = { slug: "custom" }
		const updatedModes = [modeConfig]
		;(context.provider.customModesManager.updateCustomMode as any).mockResolvedValue(undefined)
		;(context.provider.customModesManager.getCustomModes as any).mockReturnValue(updatedModes)

		await router.route(context, { type: "updateCustomMode", modeConfig } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("customModes", updatedModes)
		expect(context.updateGlobalState).toHaveBeenCalledWith("mode", "custom")
	})

	it("checkRulesDirectory posts result with slug and hasContent", async () => {
		;(context.provider.customModesManager.checkRulesDirectoryHasContent as any).mockResolvedValue(true)

		await router.route(context, { type: "checkRulesDirectory", slug: "my-mode" } as any)

		expect(context.provider.customModesManager.checkRulesDirectoryHasContent).toHaveBeenCalledWith("my-mode")
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "checkRulesDirectoryResult",
			slug: "my-mode",
			hasContent: true,
		})
	})

	it("openKeyboardShortcuts executes keybindings command", async () => {
		const vscode = await import("vscode")

		await router.route(context, { type: "openKeyboardShortcuts", text: "" } as WebviewMessage)

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.openGlobalKeybindings")
	})

	it("openKeyboardShortcuts executes with search query", async () => {
		const vscode = await import("vscode")

		await router.route(context, { type: "openKeyboardShortcuts", text: "terminal" } as WebviewMessage)

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.openGlobalKeybindings", "terminal")
	})

	it("requestCommands posts commands to webview", async () => {
		const { getCommands } = await import("../../../services/command/commands")
		;(getCommands as any).mockResolvedValue([{ name: "test-cmd", source: "project", filePath: "/path" }])

		await router.route(context, { type: "requestCommands" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "commands" }),
		)
	})

	it("requestCommands handles error by posting empty array", async () => {
		const { getCommands } = await import("../../../services/command/commands")
		;(getCommands as any).mockRejectedValue(new Error("fail"))

		await router.route(context, { type: "requestCommands" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "commands",
			commands: [],
		})
	})
})
