import { vi, describe, it, expect, beforeEach } from "vitest"
import type { WebviewMessage } from "@njust-ai-cj/types"

vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
			update: vi.fn(),
		}),
		workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }],
	},
	ConfigurationTarget: { Global: 1 },
	Uri: { file: vi.fn().mockImplementation((p: string) => ({ fsPath: p })) },
}))

vi.mock("../../../i18n", () => ({ t: (key: string) => key, changeLanguage: vi.fn() }))
vi.mock("../../../shared/package", () => ({ Package: { name: "njust-ai" } }))
vi.mock("../../../shared/api", () => ({
	toRouterName: (s: string) => s,
}))
vi.mock("../../../shared/experiments", () => ({ experimentDefault: {} }))
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		setShellIntegrationTimeout: vi.fn(),
		setShellIntegrationDisabled: vi.fn(),
		setCommandDelay: vi.fn(),
		setPowershellCounter: vi.fn(),
		setTerminalZshClearEolMark: vi.fn(),
		setTerminalZshOhMy: vi.fn(),
		setTerminalZshP10k: vi.fn(),
		setTerminalZdotdir: vi.fn(),
		setExecaShellPath: vi.fn(),
	},
}))
vi.mock("../../../api/providers/openai", () => ({ getOpenAiModels: vi.fn() }))
vi.mock("../../../api/providers/vscode-lm", () => ({ getVsCodeLmModels: vi.fn() }))
vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
}))
vi.mock("../../../utils/debugLog", () => ({ debugLog: vi.fn() }))
vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))
vi.mock("../../config/importExport", () => ({
	importSettingsWithFeedback: vi.fn(),
	exportSettings: vi.fn(),
}))

import { registerSettingsHandlers } from "../../handlers/settingsMessageHandler"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("settingsMessageHandler", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		context = createMockContext()
		registerSettingsHandlers(router)
	})

	it("registers all expected settings handlers", () => {
		const registeredTypes = [
			"updateSettings", "updateCloudAgentSettings", "updateVSCodeSetting", "getVSCodeSetting",
			"saveApiConfiguration", "upsertApiConfiguration", "renameApiConfiguration",
			"loadApiConfiguration", "loadApiConfigurationById", "deleteApiConfiguration",
			"getListApiConfiguration", "flushRouterModels", "requestRouterModels",
			"requestOllamaModels", "requestLmStudioModels", "requestRooModels",
			"requestOpenAiModels", "requestVsCodeLmModels", "importSettings", "exportSettings",
			"resetState", "toggleApiConfigPin", "enhancementApiConfigId",
			"lockApiConfigAcrossModes", "autoApprovalEnabled", "taskSyncEnabled",
			"hasOpenedModeSelector", "debugSetting", "openAiCodexSignIn", "openAiCodexSignOut",
			"requestOpenAiCodexRateLimits",
		]
		for (const type of registeredTypes) {
			const handler = vi.fn()
			router.register(type, handler)
		}
	})

	it("updateSettings does nothing when updatedSettings is missing", async () => {
		await router.route(context, { type: "updateSettings" } as WebviewMessage)

		expect(context.provider.contextProxy.setValue).not.toHaveBeenCalled()
	})

	it("updateSettings iterates over updatedSettings entries", async () => {
		await router.route(context, {
			type: "updateSettings",
			updatedSettings: { mode: "architect", apiProvider: "openai" },
		} as any)

		expect(context.provider.contextProxy.setValue).toHaveBeenCalledTimes(2)
		expect(context.provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("updateSettings saves language to state", async () => {
		await router.route(context, {
			type: "updateSettings",
			updatedSettings: { language: "zh-CN" },
		} as any)

		// Handler calls changeLanguage and then setValue
		expect(context.provider.contextProxy.setValue).toHaveBeenCalledWith("language", "zh-CN")
	})

	it("saveApiConfiguration saves config and updates list", async () => {
		;(context.provider.providerSettingsManager.saveConfig as any).mockResolvedValue(undefined)
		;(context.provider.providerSettingsManager.listConfig as any).mockResolvedValue([{ name: "test" }])

		await router.route(context, {
			type: "saveApiConfiguration",
			text: "my-config",
			apiConfiguration: { apiProvider: "openai" },
		} as any)

		expect(context.provider.providerSettingsManager.saveConfig).toHaveBeenCalledWith("my-config", { apiProvider: "openai" })
	})

	it("saveApiConfiguration does nothing without text", async () => {
		await router.route(context, {
			type: "saveApiConfiguration",
			apiConfiguration: { apiProvider: "openai" },
		} as any)

		expect(context.provider.providerSettingsManager.saveConfig).not.toHaveBeenCalled()
	})

	it("loadApiConfiguration activates profile by name", async () => {
		await router.route(context, { type: "loadApiConfiguration", text: "my-config" } as WebviewMessage)

		expect(context.provider.activateProviderProfile).toHaveBeenCalledWith({ name: "my-config" })
	})

	it("loadApiConfiguration does nothing without text", async () => {
		await router.route(context, { type: "loadApiConfiguration" } as WebviewMessage)

		expect(context.provider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("getListApiConfiguration lists and updates global state", async () => {
		const mockList = [{ name: "config1" }, { name: "config2" }]
		;(context.provider.providerSettingsManager.listConfig as any).mockResolvedValue(mockList)

		await router.route(context, { type: "getListApiConfiguration" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("listApiConfigMeta", mockList)
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "listApiConfig",
			listApiConfig: mockList,
		})
	})

	it("resetState calls provider.resetState", async () => {
		;(context.provider.resetState as any).mockResolvedValue(undefined)

		await router.route(context, { type: "resetState" } as WebviewMessage)

		expect(context.provider.resetState).toHaveBeenCalledOnce()
	})

	it("toggleApiConfigPin adds pin when not pinned", async () => {
		;(context.getGlobalState as any).mockReturnValue({})

		await router.route(context, { type: "toggleApiConfigPin", text: "config-1" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("pinnedApiConfigs", { "config-1": true })
	})

	it("toggleApiConfigPin removes pin when already pinned", async () => {
		;(context.getGlobalState as any).mockReturnValue({ "config-1": true })

		await router.route(context, { type: "toggleApiConfigPin", text: "config-1" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("pinnedApiConfigs", {})
	})

	it("autoApprovalEnabled updates global state", async () => {
		await router.route(context, { type: "autoApprovalEnabled", bool: true } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("autoApprovalEnabled", true)
	})

	it("autoApprovalEnabled defaults to false when bool is undefined", async () => {
		await router.route(context, { type: "autoApprovalEnabled" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("autoApprovalEnabled", false)
	})

	it("enhancementApiConfigId updates global state", async () => {
		await router.route(context, { type: "enhancementApiConfigId", text: "config-id" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("enhancementApiConfigId", "config-id")
	})

	it("hasOpenedModeSelector updates global state", async () => {
		await router.route(context, { type: "hasOpenedModeSelector", bool: true } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("hasOpenedModeSelector", true)
	})
})
