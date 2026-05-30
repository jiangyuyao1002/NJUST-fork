import type { WebviewMessage } from "@njust-ai/types"
import { CodeIndexManager } from "../../../services/code-index/manager"
import { t } from "../../../i18n"
import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"
import { getErrorMessage } from "../../../shared/error-utils"

export function registerIndexingHandlers(router: MessageRouter): void {
	router.register("saveCodeIndexSettingsAtomic", handleSaveCodeIndexSettingsAtomic)
	router.register("requestIndexingStatus", handleRequestIndexingStatus)
	router.register("requestCodeIndexSecretStatus", handleRequestCodeIndexSecretStatus)
	router.register("startIndexing", handleStartIndexing)
	router.register("stopIndexing", handleStopIndexing)
	router.register("toggleWorkspaceIndexing", handleToggleWorkspaceIndexing)
	router.register("setAutoEnableDefault", handleSetAutoEnableDefault)
	router.register("clearIndexData", handleClearIndexData)
}

async function handleSaveCodeIndexSettingsAtomic(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider, getGlobalState, updateGlobalState } = context
	if (!message.codeIndexSettings) return
	const s = message.codeIndexSettings
	try {
		const currentConfig = getGlobalState("codebaseIndexConfig") || {}
		const embedderProviderChanged = currentConfig.codebaseIndexEmbedderProvider !== s.codebaseIndexEmbedderProvider
		const cfg = {
			...currentConfig,
			codebaseIndexEnabled: s.codebaseIndexEnabled,
			codebaseIndexQdrantUrl: s.codebaseIndexQdrantUrl,
			codebaseIndexEmbedderProvider: s.codebaseIndexEmbedderProvider,
			codebaseIndexEmbedderBaseUrl: s.codebaseIndexEmbedderBaseUrl,
			codebaseIndexEmbedderModelId: s.codebaseIndexEmbedderModelId,
			codebaseIndexEmbedderModelDimension: s.codebaseIndexEmbedderModelDimension,
			codebaseIndexOpenAiCompatibleBaseUrl: s.codebaseIndexOpenAiCompatibleBaseUrl,
			codebaseIndexBedrockRegion: s.codebaseIndexBedrockRegion,
			codebaseIndexBedrockProfile: s.codebaseIndexBedrockProfile,
			codebaseIndexSearchMaxResults: s.codebaseIndexSearchMaxResults,
			codebaseIndexSearchMinScore: s.codebaseIndexSearchMinScore,
			codebaseIndexOpenRouterSpecificProvider: s.codebaseIndexOpenRouterSpecificProvider,
		}
		await updateGlobalState("codebaseIndexConfig", cfg)
		if (s.codeIndexOpenAiKey !== undefined) await provider.contextProxy.storeSecret("codeIndexOpenAiKey", s.codeIndexOpenAiKey)
		if (s.codeIndexQdrantApiKey !== undefined) await provider.contextProxy.storeSecret("codeIndexQdrantApiKey", s.codeIndexQdrantApiKey)
		if (s.codebaseIndexOpenAiCompatibleApiKey !== undefined) await provider.contextProxy.storeSecret("codebaseIndexOpenAiCompatibleApiKey", s.codebaseIndexOpenAiCompatibleApiKey)
		if (s.codebaseIndexGeminiApiKey !== undefined) await provider.contextProxy.storeSecret("codebaseIndexGeminiApiKey", s.codebaseIndexGeminiApiKey)
		if (s.codebaseIndexMistralApiKey !== undefined) await provider.contextProxy.storeSecret("codebaseIndexMistralApiKey", s.codebaseIndexMistralApiKey)
		if (s.codebaseIndexVercelAiGatewayApiKey !== undefined) await provider.contextProxy.storeSecret("codebaseIndexVercelAiGatewayApiKey", s.codebaseIndexVercelAiGatewayApiKey)
		if (s.codebaseIndexOpenRouterApiKey !== undefined) await provider.contextProxy.storeSecret("codebaseIndexOpenRouterApiKey", s.codebaseIndexOpenRouterApiKey)

		await provider.postMessageToWebview({ type: "codeIndexSettingsSaved", success: true, settings: cfg })
		await provider.postStateToWebview()

		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (mgr) {
			if (embedderProviderChanged) {
				try {
					await mgr.handleSettingsChange()
				} catch (error) {
					provider.log(`Embedder validation failed after provider change: ${getErrorMessage(error)}`)
					await provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
					return
				}
			} else {
				try { await mgr.handleSettingsChange() } catch (error) {
					provider.log(`Settings change handling error: ${getErrorMessage(error)}`)
				}
			}
			await new Promise((r) => setTimeout(r, 200))
			if (mgr.isFeatureEnabled && mgr.isFeatureConfigured && !mgr.isInitialized) {
				try { await mgr.initialize(provider.contextProxy) } catch (error) {
					provider.log(`Code index initialization failed: ${getErrorMessage(error)}`)
					await provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
				}
			}
		} else {
			provider.log("Cannot save code index settings: No workspace folder open")
			await provider.postMessageToWebview({ type: "indexingStatusUpdate", values: { systemStatus: "Error", message: t("embeddings:orchestrator.indexingRequiresWorkspace"), processedItems: 0, totalItems: 0, currentItemUnit: "items" } })
		}
	} catch (error) {
		provider.log(`Error saving code index settings: ${getErrorMessage(error)}`)
		await provider.postMessageToWebview({ type: "codeIndexSettingsSaved", success: false, error: getErrorMessage(error) })
	}
}

function handleRequestIndexingStatus(context: MessageHandlerContext, _message: WebviewMessage): void {
	const { provider } = context
	const mgr = provider.getCurrentWorkspaceCodeIndexManager()
	if (!mgr) {
		void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: { systemStatus: "Error", message: t("embeddings:orchestrator.indexingRequiresWorkspace"), processedItems: 0, totalItems: 0, currentItemUnit: "items", workerspacePath: undefined } })
		return
	}
	void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
}

async function handleRequestCodeIndexSecretStatus(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	const v = (k: string) => provider.context.secrets.get(k).then(Boolean)
	void provider.postMessageToWebview({ type: "codeIndexSecretStatus", values: {
		hasOpenAiKey: await v("codeIndexOpenAiKey"),
		hasQdrantApiKey: await v("codeIndexQdrantApiKey"),
		hasOpenAiCompatibleApiKey: await v("codebaseIndexOpenAiCompatibleApiKey"),
		hasGeminiApiKey: await v("codebaseIndexGeminiApiKey"),
		hasMistralApiKey: await v("codebaseIndexMistralApiKey"),
		hasVercelAiGatewayApiKey: await v("codebaseIndexVercelAiGatewayApiKey"),
		hasOpenRouterApiKey: await v("codebaseIndexOpenRouterApiKey"),
	} })
}

async function handleStartIndexing(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (!mgr) { void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: { systemStatus: "Error", message: t("embeddings:orchestrator.indexingRequiresWorkspace"), processedItems: 0, totalItems: 0, currentItemUnit: "items" } }); provider.log("Cannot start indexing: No workspace folder open"); return }
		await mgr.setWorkspaceEnabled(true)
		if (mgr.isFeatureEnabled && mgr.isFeatureConfigured) {
			await mgr.initialize(provider.contextProxy)
			if (mgr.state === "Standby" || mgr.state === "Error") {
				void mgr.startIndexing()
				if (!mgr.isInitialized) { await mgr.initialize(provider.contextProxy); if (mgr.state === "Standby" || mgr.state === "Error") void mgr.startIndexing() }
			}
		}
	} catch (error) { provider.log(`Error starting indexing: ${getErrorMessage(error)}`) }
}

function handleStopIndexing(context: MessageHandlerContext, _message: WebviewMessage): void {
	const { provider } = context
	try {
		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (!mgr) { provider.log("Cannot stop indexing: No workspace folder open"); return }
		mgr.stopIndexing()
		void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
	} catch (error) { provider.log(`Error stopping indexing: ${getErrorMessage(error)}`) }
}

async function handleToggleWorkspaceIndexing(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (!mgr) { provider.log("Cannot toggle workspace indexing: No workspace folder open"); return }
		const enabled = message.bool ?? false
		await mgr.setWorkspaceEnabled(enabled)
		if (enabled && mgr.isFeatureEnabled && mgr.isFeatureConfigured) { await mgr.initialize(provider.contextProxy); void mgr.startIndexing() }
		else if (!enabled) mgr.stopIndexing()
		void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
	} catch (error) { provider.log(`Error toggling workspace indexing: ${getErrorMessage(error)}`) }
}

async function handleSetAutoEnableDefault(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (!mgr) { provider.log("Cannot set auto-enable default: No workspace folder open"); return }
		const all = CodeIndexManager.getAllInstances()
		const prior = new Map(all.map((m) => [m, m.isWorkspaceEnabled]))
		await mgr.setAutoEnableDefault(message.bool ?? true)
		for (const m of all) {
			const was = prior.get(m)!
			const now = m.isWorkspaceEnabled
			if (was && !now) m.stopIndexing()
			else if (!was && now && m.isFeatureEnabled && m.isFeatureConfigured) { await m.initialize(provider.contextProxy); void m.startIndexing() }
		}
		void provider.postMessageToWebview({ type: "indexingStatusUpdate", values: mgr.getCurrentStatus() })
	} catch (error) { provider.log(`Error setting auto-enable default: ${getErrorMessage(error)}`) }
}

async function handleClearIndexData(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const mgr = provider.getCurrentWorkspaceCodeIndexManager()
		if (!mgr) { void provider.postMessageToWebview({ type: "indexCleared", values: { success: false, error: t("embeddings:orchestrator.indexingRequiresWorkspace") } }); return }
		await mgr.clearIndexData()
		void provider.postMessageToWebview({ type: "indexCleared", values: { success: true } })
	} catch (error) { void provider.postMessageToWebview({ type: "indexCleared", values: { success: false, error: getErrorMessage(error) } }) }
}
