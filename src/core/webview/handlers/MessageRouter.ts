import type { ClineProvider } from "../ClineProvider"
import type { WebviewMessage, GlobalState } from "@njust-ai/types"
import { logger } from "../../../shared/logger"

export type MessageHandler = (context: MessageHandlerContext, message: WebviewMessage) => void | Promise<void>

export interface MessageHandlerContext {
	provider: ClineProvider
	getGlobalState: <K extends keyof GlobalState>(key: K) => GlobalState[K] | undefined
	updateGlobalState: <K extends keyof GlobalState>(key: K, value: GlobalState[K]) => Promise<void>
	getCurrentCwd: () => string
	getCurrentMode: () => Promise<string>
}

/** Known webview message types (allowlist). Prevents XSS from posting arbitrary types. */
const ALLOWED_MESSAGE_TYPES = new Set<string>([
	"updateTodoList",
	"deleteMultipleTasksWithIds",
	"currentApiConfigName",
	"saveApiConfiguration",
	"upsertApiConfiguration",
	"deleteApiConfiguration",
	"loadApiConfiguration",
	"loadApiConfigurationById",
	"renameApiConfiguration",
	"getListApiConfiguration",
	"customInstructions",
	"webviewDidLaunch",
	"newTask",
	"askResponse",
	"terminalOperation",
	"updateCloudAgentSettings",
	"clearTask",
	"didShowAnnouncement",
	"selectImages",
	"selectContextFiles",
	"exportCurrentTask",
	"shareCurrentTask",
	"showTaskWithId",
	"deleteTaskWithId",
	"exportTaskWithId",
	"importSettings",
	"exportSettings",
	"resetState",
	"flushRouterModels",
	"requestRouterModels",
	"requestOpenAiModels",
	"requestOllamaModels",
	"requestLmStudioModels",
	"requestRooModels",
	"requestRooCreditBalance",
	"requestVsCodeLmModels",
	"openImage",
	"saveImage",
	"openFile",
	"readFileContent",
	"openMention",
	"cancelTask",
	"cancelAutoApproval",
	"updateVSCodeSetting",
	"getVSCodeSetting",
	"vsCodeSetting",
	"updateCondensingPrompt",
	"playSound",
	"playTts",
	"stopTts",
	"ttsEnabled",
	"ttsSpeed",
	"openKeyboardShortcuts",
	"openMcpSettings",
	"openProjectMcpSettings",
	"restartMcpServer",
	"refreshAllMcpServers",
	"toggleToolAlwaysAllow",
	"toggleToolEnabledForPrompt",
	"toggleMcpServer",
	"updateMcpTimeout",
	"enhancePrompt",
	"enhancedPrompt",
	"draggedImages",
	"deleteMessage",
	"deleteMessageConfirm",
	"submitEditedMessage",
	"editMessageConfirm",
	"taskSyncEnabled",
	"searchCommits",
	"setApiConfigPassword",
	"mode",
	"updatePrompt",
	"getSystemPrompt",
	"copySystemPrompt",
	"systemPrompt",
	"enhancementApiConfigId",
	"autoApprovalEnabled",
	"updateCustomMode",
	"deleteCustomMode",
	"setopenAiCustomModelInfo",
	"openCustomModesSettings",
	"checkpointDiff",
	"checkpointRestore",
	"deleteMcpServer",
	"codebaseIndexEnabled",
	"searchFiles",
	"toggleApiConfigPin",
	"hasOpenedModeSelector",
	"lockApiConfigAcrossModes",
	"clearCloudAuthSkipModel",
	"rooCloudSignIn",
	"cloudLandingPageSignIn",
	"rooCloudSignOut",
	"rooCloudManualUrl",
	"openAiCodexSignIn",
	"openAiCodexSignOut",
	"switchOrganization",
	"condenseTaskContextRequest",
	"requestIndexingStatus",
	"startIndexing",
	"stopIndexing",
	"clearIndexData",
	"indexingStatusUpdate",
	"indexCleared",
	"toggleWorkspaceIndexing",
	"setAutoEnableDefault",
	"focusPanelRequest",
	"openExternal",
	"switchTab",
	"shareTaskSuccess",
	"exportMode",
	"exportModeResult",
	"importMode",
	"importModeResult",
	"checkRulesDirectory",
	"checkRulesDirectoryResult",
	"saveCodeIndexSettingsAtomic",
	"requestCodeIndexSecretStatus",
	"requestCommands",
	"openCommandFile",
	"deleteCommand",
	"createCommand",
	"insertTextIntoTextarea",
	"showMdmAuthRequiredNotification",
	"imageGenerationSettings",
	"queueMessage",
	"removeQueuedMessage",
	"editQueuedMessage",
	"dismissUpsell",
	"getDismissedUpsells",
	"openMarkdownPreview",
	"updateSettings",
	"allowedCommands",
	"getTaskWithAggregatedCosts",
	"deniedCommands",
	"openDebugApiHistory",
	"openDebugUiHistory",
	"downloadErrorDiagnostics",
	"requestOpenAiCodexRateLimits",
	"refreshCustomTools",
	"requestModes",
	"switchMode",
	"debugSetting",
	"transcribeAudio",
	"cloudAgentGetProfiles",
	"cloudAgentSaveProfile",
	"cloudAgentDeleteProfile",
	"cloudAgentSetActiveProfile",
	"testWebSearch",
	"requestSkills",
	"createSkill",
	"deleteSkill",
	"moveSkill",
	"updateSkillModes",
	"openSkillFile",
	"planAction",
	"webviewError",
	"openRouterOAuthState",
])

export class MessageRouter {
	private handlers = new Map<string, MessageHandler>()

	register(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler)
	}

	async route(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
		if (!message || typeof message !== "object" || !message.type) {
			logger.warn("MessageRouter", "Rejected malformed webview message")
			return
		}

		if (!ALLOWED_MESSAGE_TYPES.has(message.type)) {
			logger.warn("MessageRouter", `Rejected unknown message type: ${message.type}`)
			return
		}

		const handler = this.handlers.get(message.type)
		if (handler) {
			await handler(context, message)
		} else {
			logger.warn("MessageRouter", `No handler registered for message type: ${message.type}`)
		}
	}
}
