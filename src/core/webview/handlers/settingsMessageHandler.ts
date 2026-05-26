import * as vscode from "vscode"
import {
	type GlobalState,
	type Language,
	type ModelRecord,
	type WebviewMessage,
	ExperimentId,
	TelemetryEventName,
} from "@njust-ai-cj/types"

import { type RouterName, toRouterName } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { changeLanguage, t } from "../../../i18n"
import { Terminal } from "../../../integrations/terminal/Terminal"
import { getOpenAiModels } from "../../../api/providers/openai"
import { getVsCodeLmModels } from "../../../api/providers/vscode-lm"
import { getModels, flushModels, listProviderModels } from "../../../api/providers/fetchers/modelCache"
import { GetModelsOptions } from "../../../shared/api"
import { experimentDefault } from "../../../shared/experiments"
import { importSettingsWithFeedback, exportSettings } from "../../config/importExport"
import { debugLog } from "../../../utils/debugLog"

import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"
import { logger } from "../../../shared/logger"
import { getErrorMessage } from "../../../shared/error-utils"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { clearOpenAiCodexAuthCache } from "../WebviewStateBuilder"

const ALLOWED_VSCODE_SETTINGS = new Set(["terminal.integrated.inheritEnv"])

export function registerSettingsHandlers(router: MessageRouter): void {
	router.register("updateSettings", handleUpdateSettings)
	router.register("updateCloudAgentSettings", handleUpdateCloudAgentSettings)
	router.register("updateVSCodeSetting", handleUpdateVSCodeSetting)
	router.register("getVSCodeSetting", handleGetVSCodeSetting)
	router.register("saveApiConfiguration", handleSaveApiConfiguration)
	router.register("upsertApiConfiguration", handleUpsertApiConfiguration)
	router.register("renameApiConfiguration", handleRenameApiConfiguration)
	router.register("loadApiConfiguration", handleLoadApiConfiguration)
	router.register("loadApiConfigurationById", handleLoadApiConfigurationById)
	router.register("deleteApiConfiguration", handleDeleteApiConfiguration)
	router.register("getListApiConfiguration", handleGetListApiConfiguration)
	router.register("flushRouterModels", handleFlushRouterModels)
	router.register("requestRouterModels", handleRequestRouterModels)
	router.register("requestOllamaModels", handleRequestOllamaModels)
	router.register("requestLmStudioModels", handleRequestLmStudioModels)
	router.register("requestRooModels", handleRequestRooModels)
	router.register("requestOpenAiModels", handleRequestOpenAiModels)
	router.register("requestVsCodeLmModels", handleRequestVsCodeLmModels)
	router.register("importSettings", handleImportSettings)
	router.register("exportSettings", handleExportSettings)
	router.register("resetState", handleResetState)
	router.register("toggleApiConfigPin", handleToggleApiConfigPin)
	router.register("enhancementApiConfigId", handleEnhancementApiConfigId)
	router.register("lockApiConfigAcrossModes", handleLockApiConfigAcrossModes)
	router.register("autoApprovalEnabled", handleAutoApprovalEnabled)
	router.register("taskSyncEnabled", handleTaskSyncEnabled)
	router.register("hasOpenedModeSelector", handleHasOpenedModeSelector)
	router.register("debugSetting", handleDebugSetting)
	router.register("openAiCodexSignIn", handleOpenAiCodexSignIn)
	router.register("openAiCodexSignOut", handleOpenAiCodexSignOut)
	router.register("requestOpenAiCodexRateLimits", handleRequestOpenAiCodexRateLimits)
}

async function handleUpdateSettings(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState } = context
	if (!message.updatedSettings) return

	for (const [key, value] of Object.entries(message.updatedSettings)) {
		let newValue = value

		if (key === "language") {
			newValue = value ?? "en"
			changeLanguage(newValue as Language)
		} else if (key === "allowedCommands") {
			const commands = value ?? []
			newValue = Array.isArray(commands)
				? commands.filter((cmd: unknown) => typeof cmd === "string" && (cmd as string).trim().length > 0)
				: []
			await vscode.workspace.getConfiguration(Package.name).update("allowedCommands", newValue, vscode.ConfigurationTarget.Global)
		} else if (key === "deniedCommands") {
			const commands = value ?? []
			newValue = Array.isArray(commands)
				? commands.filter((cmd: unknown) => typeof cmd === "string" && (cmd as string).trim().length > 0)
				: []
			await vscode.workspace.getConfiguration(Package.name).update("deniedCommands", newValue, vscode.ConfigurationTarget.Global)
		} else if (key === "ttsEnabled") {
			newValue = value ?? true
			const { setTtsEnabled } = await import("../../../utils/tts")
			setTtsEnabled(newValue as boolean)
		} else if (key === "ttsSpeed") {
			newValue = value ?? 1.0
			const { setTtsSpeed } = await import("../../../utils/tts")
			setTtsSpeed(newValue as number)
		} else if (key === "terminalShellIntegrationTimeout") {
			if (value !== undefined) Terminal.setShellIntegrationTimeout(value as number)
		} else if (key === "terminalShellIntegrationDisabled") {
			if (value !== undefined) Terminal.setShellIntegrationDisabled(value as boolean)
		} else if (key === "terminalCommandDelay") {
			if (value !== undefined) Terminal.setCommandDelay(value as number)
		} else if (key === "terminalPowershellCounter") {
			if (value !== undefined) Terminal.setPowershellCounter(value as boolean)
		} else if (key === "terminalZshClearEolMark") {
			if (value !== undefined) Terminal.setTerminalZshClearEolMark(value as boolean)
		} else if (key === "terminalZshOhMy") {
			if (value !== undefined) Terminal.setTerminalZshOhMy(value as boolean)
		} else if (key === "terminalZshP10k") {
			if (value !== undefined) Terminal.setTerminalZshP10k(value as boolean)
		} else if (key === "terminalZdotdir") {
			if (value !== undefined) Terminal.setTerminalZdotdir(value as boolean)
		} else if (key === "execaShellPath") {
			Terminal.setExecaShellPath(value as string | undefined)
		} else if (key === "mcpEnabled") {
			newValue = value ?? true
			const mcpHub = provider.getMcpHub()
			if (mcpHub) await mcpHub.handleMcpEnabledChange(newValue as boolean)
		} else if (key === "experiments") {
			if (!value) continue
			newValue = {
				...(getGlobalState("experiments") ?? experimentDefault),
				...(value as Record<ExperimentId, boolean>),
			}
		} else if (key === "customSupportPrompts") {
			if (!value) continue
		} else if (key === "cloudAgentServerUrl") {
			await vscode.workspace.getConfiguration(Package.name).update("cloudAgent.serverUrl", value, vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "saveAllBeforeExecuteCommand") {
			await vscode.workspace.getConfiguration(Package.name).update("saveAllBeforeExecuteCommand", value ?? true, vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "inlineCompletionEnabled") {
			await vscode.workspace.getConfiguration(Package.name).update("inlineCompletion.enabled", value ?? true, vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "inlineCompletionTriggerDelayMs") {
			const n = typeof value === "number" ? value : 300
			await vscode.workspace.getConfiguration(Package.name).update("inlineCompletion.triggerDelayMs", Math.min(2000, Math.max(100, n)), vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "inlineCompletionMaxLines") {
			const n = typeof value === "number" ? value : 10
			await vscode.workspace.getConfiguration(Package.name).update("inlineCompletion.maxLines", Math.min(50, Math.max(1, n)), vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "inlineCompletionEnableCangjieEnhanced") {
			await vscode.workspace.getConfiguration(Package.name).update("inlineCompletion.enableCangjieEnhanced", value ?? true, vscode.ConfigurationTarget.Global)
			continue
		} else if (key === "inlineCompletionTriggerCommand") {
			const s = typeof value === "string" ? value : "alt+\\"
			await vscode.workspace.getConfiguration(Package.name).update("inlineCompletion.triggerCommand", s, vscode.ConfigurationTarget.Global)
			continue
		}

		await provider.contextProxy.setValue(key as keyof GlobalState, newValue)
	}

	await provider.postStateToWebview()
}

async function handleUpdateCloudAgentSettings(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const config = vscode.workspace.getConfiguration(Package.name)
	const msg = message as unknown as Record<string, unknown>
	if (msg.serverUrl !== undefined) await config.update("cloudAgent.serverUrl", msg.serverUrl, vscode.ConfigurationTarget.Global)
	if (msg.deferredProtocol !== undefined) await config.update("cloudAgent.deferredProtocol", msg.deferredProtocol, vscode.ConfigurationTarget.Global)
	if (msg.applyRemoteWorkspaceOps !== undefined) await config.update("cloudAgent.applyRemoteWorkspaceOps", msg.applyRemoteWorkspaceOps, vscode.ConfigurationTarget.Global)
	if (msg.confirmRemoteWorkspaceOps !== undefined) await config.update("cloudAgent.confirmRemoteWorkspaceOps", msg.confirmRemoteWorkspaceOps, vscode.ConfigurationTarget.Global)
	if (msg.compileLoopEnabled !== undefined) await config.update("cloudAgent.compileLoop.enabled", msg.compileLoopEnabled, vscode.ConfigurationTarget.Global)
	if (msg.compileLoopMaxRetries !== undefined) await config.update("cloudAgent.compileLoop.maxRetries", msg.compileLoopMaxRetries, vscode.ConfigurationTarget.Global)
	await provider.postStateToWebview()
}

async function handleUpdateVSCodeSetting(_context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { setting, value } = message
	if (setting !== undefined && value !== undefined) {
		if (ALLOWED_VSCODE_SETTINGS.has(setting)) {
			await vscode.workspace.getConfiguration().update(setting, value, true)
		} else {
			vscode.window.showErrorMessage(`Cannot update restricted VSCode setting: ${setting}`)
		}
	}
}

async function handleGetVSCodeSetting(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const { setting } = message
	if (setting) {
		try {
			await provider.postMessageToWebview({
				type: "vsCodeSetting",
				setting,
				value: vscode.workspace.getConfiguration().get(setting),
			})
		} catch (error) {
			logger.error("SettingsMessageHandler", `Failed to get VSCode setting ${message.setting}:`, error)
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			await provider.postMessageToWebview({
				type: "vsCodeSetting",
				setting,
				error: `Failed to get setting: ${getErrorMessage(error)}`,
				value: undefined,
			})
		}
	}
}

async function handleSaveApiConfiguration(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	if (message.text && message.apiConfiguration) {
		try {
			await provider.providerSettingsManager.saveConfig(message.text, message.apiConfiguration)
			const listApiConfig = await provider.providerSettingsManager.listConfig()
			await updateGlobalState("listApiConfigMeta", listApiConfig)
		} catch (error) {
			provider.log(`Error save api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.save_api_config"))
		}
	}
}

async function handleUpsertApiConfiguration(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.text && message.apiConfiguration) {
		await provider.upsertProviderProfile(message.text, message.apiConfiguration)
	}
}

async function handleRenameApiConfiguration(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.values && message.apiConfiguration) {
		try {
			const { oldName, newName } = message.values
			if (oldName === newName) return
			const { id } = await provider.providerSettingsManager.getProfile({ name: oldName })
			await provider.providerSettingsManager.saveConfig(newName, { ...message.apiConfiguration, id })
			await provider.providerSettingsManager.deleteConfig(oldName)
			await provider.activateProviderProfile({ name: newName })
		} catch (error) {
			provider.log(`Error rename api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.rename_api_config"))
		}
	}
}

async function handleLoadApiConfiguration(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.text) {
		try {
			await provider.activateProviderProfile({ name: message.text })
		} catch (error) {
			provider.log(`Error load api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.load_api_config"))
		}
	}
}

async function handleLoadApiConfigurationById(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message.text) {
		try {
			await provider.activateProviderProfile({ id: message.text })
		} catch (error) {
			provider.log(`Error load api configuration by ID: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
			vscode.window.showErrorMessage(t("common:errors.load_api_config"))
		}
	}
}

async function handleDeleteApiConfiguration(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (!message.text) return
	const answer = await vscode.window.showInformationMessage(
		t("common:confirmation.delete_config_profile"),
		{ modal: true },
		t("common:answers.yes"),
	)
	if (answer !== t("common:answers.yes")) return

	const oldName = message.text
	const newName = (await provider.providerSettingsManager.listConfig()).filter((c: { name: string }) => c.name !== oldName)[0]?.name
	if (!newName) {
		vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
		return
	}
	try {
		await provider.providerSettingsManager.deleteConfig(oldName)
		await provider.activateProviderProfile({ name: newName })
	} catch (error) {
		provider.log(`Error delete api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.delete_api_config"))
	}
}

async function handleGetListApiConfiguration(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	try {
		const listApiConfig = await provider.providerSettingsManager.listConfig()
		await updateGlobalState("listApiConfigMeta", listApiConfig)
		void provider.postMessageToWebview({ type: "listApiConfig", listApiConfig })
	} catch (error) {
		provider.log(`Error get list api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		vscode.window.showErrorMessage(t("common:errors.list_api_config"))
	}
}

async function handleFlushRouterModels(_context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const routerNameFlush: RouterName = toRouterName(message.text)
	await flushModels({ provider: routerNameFlush } as GetModelsOptions, true)
}

async function handleRequestRouterModels(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const { apiConfiguration } = await provider.getState()
	const requestedProvider = message?.values?.provider
	const providerFilter = requestedProvider ? toRouterName(requestedProvider) : undefined
	const shouldRefresh = message?.values?.refresh === true

	const routerModels: Partial<Record<RouterName, ModelRecord>> = providerFilter
		? {}
		: { openrouter: {}, "vercel-ai-gateway": {}, litellm: {}, requesty: {}, unbound: {}, ollama: {}, lmstudio: {}, roo: {} }

	const getProviderModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
		const oldProviders = ["openrouter", "requesty", "unbound", "vercel-ai-gateway", "litellm", "roo", "ollama", "lmstudio"]
		if (oldProviders.includes(options.provider)) {
			return getModels(options)
		}

		return listProviderModels(options.provider, {
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
			forceRefresh: shouldRefresh,
		})
	}

	const safeGetModels = async (options: GetModelsOptions): Promise<ModelRecord> => {
		try { return await getProviderModels(options) } catch (error) {
			logger.error("SettingsMessageHandler", `Failed to fetch models for ${options.provider}:`, error)
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			throw error
		}
	}

	const candidates: { key: RouterName; options: GetModelsOptions }[] = [
		{ key: "openrouter", options: { provider: "openrouter" } },
		{ key: "requesty", options: { provider: "requesty", apiKey: apiConfiguration.requestyApiKey, baseUrl: apiConfiguration.requestyBaseUrl } },
		{ key: "unbound", options: { provider: "unbound", apiKey: apiConfiguration.unboundApiKey } },
		{ key: "vercel-ai-gateway", options: { provider: "vercel-ai-gateway" } },
		{ key: "roo", options: { provider: "roo", baseUrl: process.env.NJUST_AI_CJ_PROVIDER_URL ?? "", apiKey: undefined } },
		{
			key: "deepseek",
			options: {
				provider: "deepseek",
				apiKey: apiConfiguration.deepSeekApiKey,
				baseUrl: apiConfiguration.deepSeekBaseUrl,
			},
		},
		{
			key: "gemini",
			options: {
				provider: "gemini",
				apiKey: apiConfiguration.geminiApiKey,
				baseUrl: apiConfiguration.googleGeminiBaseUrl,
			},
		},
		{
			key: "anthropic",
			options: {
				provider: "anthropic",
				apiKey: apiConfiguration.apiKey,
				baseUrl: apiConfiguration.anthropicBaseUrl,
			},
		},
		{
			key: "openai-native",
			options: {
				provider: "openai-native",
				apiKey: apiConfiguration.openAiNativeApiKey,
				baseUrl: apiConfiguration.openAiNativeBaseUrl,
			},
		},
		{
			key: "mistral",
			options: {
				provider: "mistral",
				apiKey: apiConfiguration.mistralApiKey,
				baseUrl: apiConfiguration.mistralCodestralUrl,
			},
		},
		{
			key: "xai",
			options: {
				provider: "xai",
				apiKey: apiConfiguration.xaiApiKey,
			},
		},
		{
			key: "qwen",
			options: {
				provider: "qwen",
				apiKey: apiConfiguration.qwenApiKey,
				baseUrl: apiConfiguration.qwenBaseUrl,
			},
		},
		{
			key: "moonshot",
			options: {
				provider: "moonshot",
				apiKey: apiConfiguration.moonshotApiKey,
				baseUrl: apiConfiguration.moonshotBaseUrl,
			},
		},
		{
			key: "glm",
			options: {
				provider: "glm",
				apiKey: apiConfiguration.glmApiKey,
				baseUrl: apiConfiguration.glmBaseUrl,
			},
		},
		{
			key: "minimax",
			options: {
				provider: "minimax",
				apiKey: apiConfiguration.minimaxApiKey,
				baseUrl: apiConfiguration.minimaxBaseUrl,
			},
		},
		{
			key: "fireworks",
			options: {
				provider: "fireworks",
				apiKey: apiConfiguration.fireworksApiKey,
			},
		},
		{
			key: "sambanova",
			options: {
				provider: "sambanova",
				apiKey: apiConfiguration.sambaNovaApiKey,
			},
		},
		{
			key: "baseten",
			options: {
				provider: "baseten",
				apiKey: apiConfiguration.basetenApiKey,
			},
		},
		{
			key: "doubao",
			options: {
				provider: "doubao",
				apiKey: apiConfiguration.doubaoApiKey,
				baseUrl: apiConfiguration.doubaoBaseUrl,
			},
		},
	]

	const litellmApiKey = apiConfiguration.litellmApiKey || message?.values?.litellmApiKey
	const litellmBaseUrl = apiConfiguration.litellmBaseUrl || message?.values?.litellmBaseUrl
	if (litellmApiKey && litellmBaseUrl) {
		if (message?.values?.litellmApiKey || message?.values?.litellmBaseUrl) {
			await flushModels({ provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl }, true)
		}
		candidates.push({ key: "litellm", options: { provider: "litellm", apiKey: litellmApiKey, baseUrl: litellmBaseUrl } })
	}

	const modelFetchPromises = providerFilter
		? candidates.filter(({ key }) => key === providerFilter)
		: candidates

	if (shouldRefresh && providerFilter && modelFetchPromises.length > 0) {
		await flushModels(modelFetchPromises[0]!.options, true)
	}

	const results = await Promise.allSettled(
		modelFetchPromises.map(async ({ key, options }) => {
			const models = await safeGetModels(options)
			return { key, models }
		}),
	)

	results.forEach((result, index) => {
		const routerName = modelFetchPromises[index]!.key
		if (result.status === "fulfilled") {
			routerModels[routerName] = result.value.models
		} else {
			const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason)
			logger.error("SettingsMessageHandler", `Error fetching models for ${routerName}:`, result.reason)
			routerModels[routerName] = {}
			void provider.postMessageToWebview({ type: "singleRouterModelFetchResponse", success: false, error: errorMessage, values: { provider: routerName } })
		}
	})

	void provider.postMessageToWebview({
		type: "routerModels",
		routerModels,
		values: providerFilter ? { provider: requestedProvider } : undefined,
	})
}

async function handleRequestOllamaModels(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	const { apiConfiguration: ollamaApiConfig } = await provider.getState()
	try {
		const ollamaOptions = { provider: "ollama" as const, baseUrl: ollamaApiConfig.ollamaBaseUrl, apiKey: ollamaApiConfig.ollamaApiKey }
		await flushModels(ollamaOptions, true)
		const ollamaModels = await getModels(ollamaOptions)
		if (Object.keys(ollamaModels).length > 0) {
			void provider.postMessageToWebview({ type: "ollamaModels", ollamaModels })
		}
	} catch (error) { debugLog("Ollama models fetch failed:", error) }
}

async function handleRequestLmStudioModels(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	const { apiConfiguration: lmStudioApiConfig } = await provider.getState()
	try {
		const lmStudioOptions = { provider: "lmstudio" as const, baseUrl: lmStudioApiConfig.lmStudioBaseUrl }
		await flushModels(lmStudioOptions, true)
		const lmStudioModels = await getModels(lmStudioOptions)
		if (Object.keys(lmStudioModels).length > 0) {
			void provider.postMessageToWebview({ type: "lmStudioModels", lmStudioModels })
		}
	} catch (error) { debugLog("LM Studio models fetch failed:", error) }
}

async function handleRequestRooModels(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const rooOptions = { provider: "roo" as const, baseUrl: process.env.NJUST_AI_CJ_PROVIDER_URL ?? "", apiKey: undefined }
		await flushModels(rooOptions, true)
		const rooModels = await getModels(rooOptions)
		void provider.postMessageToWebview({ type: "singleRouterModelFetchResponse", success: true, values: { provider: "roo", models: rooModels } })
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		void provider.postMessageToWebview({ type: "singleRouterModelFetchResponse", success: false, error: errorMessage, values: { provider: "roo" } })
	}
}

async function handleRequestOpenAiModels(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	if (message?.values?.baseUrl && message?.values?.apiKey) {
		const openAiModels = await getOpenAiModels(message.values.baseUrl, message.values.apiKey, message.values.openAiHeaders)
		void provider.postMessageToWebview({ type: "openAiModels", openAiModels })
	}
}

async function handleRequestVsCodeLmModels(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	const vsCodeLmModels = await getVsCodeLmModels()
	void provider.postMessageToWebview({ type: "vsCodeLmModels", vsCodeLmModels })
}

async function handleImportSettings(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	await importSettingsWithFeedback({
		providerSettingsManager: provider.providerSettingsManager,
		contextProxy: provider.contextProxy,
		customModesManager: provider.customModesManager,
		provider,
	})
}

async function handleExportSettings(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	await exportSettings({ providerSettingsManager: provider.providerSettingsManager, contextProxy: provider.contextProxy })
}

async function handleResetState(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	await context.provider.resetState()
}

async function handleToggleApiConfigPin(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { getGlobalState, updateGlobalState, provider } = context
	if (message.text) {
		const currentPinned = getGlobalState("pinnedApiConfigs") ?? {}
		const updatedPinned: Record<string, boolean> = { ...currentPinned }
		if (currentPinned[message.text]) {
			delete updatedPinned[message.text]
		} else {
			updatedPinned[message.text] = true
		}
		await updateGlobalState("pinnedApiConfigs", updatedPinned)
		await provider.postStateToWebview()
	}
}

async function handleEnhancementApiConfigId(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { updateGlobalState, provider } = context
	await updateGlobalState("enhancementApiConfigId", message.text)
	await provider.postStateToWebview()
}

async function handleLockApiConfigAcrossModes(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const enabled = message.bool ?? false
	await provider.context.workspaceState.update("lockApiConfigAcrossModes", enabled)
	await provider.postStateToWebview()
}

async function handleAutoApprovalEnabled(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { updateGlobalState, provider } = context
	await updateGlobalState("autoApprovalEnabled", message.bool ?? false)
	await provider.postStateToWebview()
}


async function handleTaskSyncEnabled(_context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	// no-op
}

async function handleHasOpenedModeSelector(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { updateGlobalState, provider } = context
	await updateGlobalState("hasOpenedModeSelector", message.bool ?? true)
	await provider.postStateToWebview()
}

async function handleDebugSetting(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	await vscode.workspace.getConfiguration(Package.name).update("debug", message.bool ?? false, vscode.ConfigurationTarget.Global)
	await provider.postStateToWebview()
}

async function handleOpenAiCodexSignIn(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
		const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()
		await vscode.env.openExternal(vscode.Uri.parse(authUrl))
		openAiCodexOAuthManager
			.waitForCallback()
			.then(async () => {
				clearOpenAiCodexAuthCache()
				vscode.window.showInformationMessage("Successfully signed in to OpenAI Codex")
				await provider.postStateToWebview()
			})
			.catch((error: Error) => {
				provider.log(`OpenAI Codex OAuth callback failed: ${error}`)
				if (!String(error).includes("timed out")) {
					vscode.window.showErrorMessage(`OpenAI Codex sign in failed: ${error.message}`)
				}
			})
	} catch (error) {
		provider.log(`OpenAI Codex OAuth failed: ${error}`)
		vscode.window.showErrorMessage("OpenAI Codex sign in failed.")
	}
}

async function handleOpenAiCodexSignOut(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
		await openAiCodexOAuthManager.clearCredentials()
		clearOpenAiCodexAuthCache()
		vscode.window.showInformationMessage("Signed out from OpenAI Codex")
		await provider.postStateToWebview()
	} catch (error) {
		provider.log(`OpenAI Codex sign out failed: ${error}`)
		vscode.window.showErrorMessage("OpenAI Codex sign out failed.")
	}
}

async function handleRequestOpenAiCodexRateLimits(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const { openAiCodexOAuthManager } = await import("../../../integrations/openai-codex/oauth")
		const accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			void provider.postMessageToWebview({ type: "openAiCodexRateLimits", error: "Not authenticated with OpenAI Codex" })
			return
		}
		const accountId = await openAiCodexOAuthManager.getAccountId()
		const { fetchOpenAiCodexRateLimitInfo } = await import("../../../integrations/openai-codex/rate-limits")
		const rateLimits = await fetchOpenAiCodexRateLimitInfo(accessToken, { accountId })
		void provider.postMessageToWebview({ type: "openAiCodexRateLimits", values: rateLimits })
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		provider.log(`Error fetching OpenAI Codex rate limits: ${errorMessage}`)
		void provider.postMessageToWebview({ type: "openAiCodexRateLimits", error: errorMessage })
	}
}
