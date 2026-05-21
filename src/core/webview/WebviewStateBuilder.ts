import * as vscode from "vscode"

import type {
	ExtensionState,
	ProviderName,
	StaticAppProperties,
	DynamicAppProperties,
	TaskProperties,
	GitProperties,
	TelemetryProperties,
	HistoryItem,
	CodebaseIndexConfig,
} from "@njust-ai-cj/types"
import {
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
	DEFAULT_REQUEST_DELAY_SECONDS,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	isRetiredProvider,
} from "@njust-ai-cj/types"
import { Package } from "../../shared/package"
import { formatLanguage } from "../../shared/language"
import { Mode, defaultModeSlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { Terminal } from "../../integrations/terminal/Terminal"
import { getWorkspaceGitInfo } from "../../utils/git"
import { logger } from "../../shared/logger"
import { getWorkspaceWebviewConfig, computePermissionMode } from "./ClineProviderState"
import type { ContextProxy } from "../config/ContextProxy"
import type { CustomModesManager } from "../config/CustomModesManager"
import type { TaskHistoryStore } from "../task-persistence/TaskHistoryStore"
import type { SettingsManager } from "./SettingsManager"
import type { IMcpHubService } from "../../services/mcp/interfaces/IMcpHubService"
import type { Task } from "../task/Task"

export type ClineProviderState = Omit<
	ExtensionState,
	"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
>

export interface IWebviewStateHost {
	contextProxy: ContextProxy
	customModesManager: CustomModesManager
	taskHistoryStore: TaskHistoryStore
	taskHistory: { initialized: boolean }
	mcpHub?: IMcpHubService
	getCurrentTask(): Task | undefined
	settingsManager: SettingsManager
	cwd: string
	renderContext: "sidebar" | "editor"
	settingsImportedAt?: number
	latestAnnouncementId: string
	cloudAuthSkipModel: boolean
	lockApiConfigAcrossModes: boolean
	extensionVersion: string
	extensionPackageJSON?: { name?: string; version?: string }
}

const STATE_FIELD_DEFAULTS = {
	alwaysAllowReadOnly: false,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: false,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowExecute: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowFollowupQuestions: false,
	followupAutoApproveTimeoutMs: 60000,
	diagnosticsEnabled: true,
	autoCondenseContext: true,
	autoCondenseContextPercent: DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	soundEnabled: false,
	ttsEnabled: false,
	ttsSpeed: 1.0,
	enableCheckpoints: true,
	checkpointTimeout: DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	enableWebSearch: false,
	enableStreamingToolExecution: true,
	webSearchProvider: "baidu-free" as const,
	serpApiEngine: "bing" as const,
	webSearchApiKey: "",
	soundVolume: 0.5,
	writeDelayMs: DEFAULT_WRITE_DELAY_MS,
	requestDelaySeconds: DEFAULT_REQUEST_DELAY_SECONDS,
	terminalOutputPreviewSize: DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
	terminalShellIntegrationDisabled: true,
	terminalCommandDelay: 0,
	terminalPowershellCounter: false,
	terminalZshClearEolMark: true,
	terminalZshOhMy: false,
	terminalZshP10k: false,
	terminalZdotdir: false,
	mode: defaultModeSlug,
	fontFamily: "serif" as const,
	mcpEnabled: true,
	currentApiConfigName: "default",
	listApiConfigMeta: [],
	pinnedApiConfigs: {},
	modeApiConfigs: {} as Record<Mode, string>,
	customModePrompts: {},
	customSupportPrompts: {},
	experiments: experimentDefault,
	autoApprovalEnabled: false,
	maxOpenTabsContext: DEFAULT_MAX_OPEN_TABS_CONTEXT,
	maxWorkspaceFiles: 200,
	showRooIgnoredFiles: false,
	enableSubfolderRules: false,
	maxImageFileSize: 5,
	maxTotalImageSize: 20,
	historyPreviewCollapsed: false,
	reasoningBlockCollapsed: true,
	enterBehavior: "send" as const,
	profileThresholds: {},
	includeDiagnosticMessages: true,
	maxDiagnosticMessages: 50,
	includeTaskHistoryInEnhance: true,
	includeCurrentTime: true,
	includeCurrentCost: true,
	maxGitStatusFiles: 0,
	codebaseIndexModels: EMBEDDING_MODEL_PROFILES,
} as const

let cachedOpenAiCodexAuth: boolean | undefined
let cachedOpenAiCodexAuthPromise: Promise<boolean> | undefined

async function getOpenAiCodexAuthState(): Promise<boolean> {
	if (cachedOpenAiCodexAuth !== undefined) return cachedOpenAiCodexAuth
	if (cachedOpenAiCodexAuthPromise) return cachedOpenAiCodexAuthPromise

	cachedOpenAiCodexAuthPromise = (async () => {
		try {
			const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
			return await openAiCodexOAuthManager.isAuthenticated()
		} catch (error) {
			logger.debug("WebviewStateBuilder", "OpenAI Codex OAuth authentication check failed", error)
			return false
		}
	})()

	cachedOpenAiCodexAuth = await cachedOpenAiCodexAuthPromise
	return cachedOpenAiCodexAuth
}

/**
 * Clear the cached OpenAI Codex authentication state.
 * Call this when the user logs in or out to ensure the webview reflects the new state.
 */
export function clearOpenAiCodexAuthCache(): void {
	cachedOpenAiCodexAuth = undefined
	cachedOpenAiCodexAuthPromise = undefined
}

function resolveCodebaseIndexConfig(source: { codebaseIndexConfig?: CodebaseIndexConfig }): ClineProviderState["codebaseIndexConfig"] {
	return {
		codebaseIndexEnabled: source.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
		codebaseIndexQdrantUrl: source.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
		codebaseIndexEmbedderProvider: source.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
		codebaseIndexEmbedderBaseUrl: source.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
		codebaseIndexEmbedderModelId: source.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
		codebaseIndexEmbedderModelDimension:
			source.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
		codebaseIndexOpenAiCompatibleBaseUrl: source.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
		codebaseIndexSearchMaxResults: source.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
		codebaseIndexSearchMinScore: source.codebaseIndexConfig?.codebaseIndexSearchMinScore,
		codebaseIndexBedrockRegion: source.codebaseIndexConfig?.codebaseIndexBedrockRegion,
		codebaseIndexBedrockProfile: source.codebaseIndexConfig?.codebaseIndexBedrockProfile,
		codebaseIndexOpenRouterSpecificProvider:
			source.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
	}
}

export async function getState(host: IWebviewStateHost): Promise<ClineProviderState> {
	const stateValues = host.contextProxy.getValues()
	const customModes = await host.customModesManager.getCustomModes()

	const apiProvider: ProviderName =
		stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
			? stateValues.apiProvider
			: "anthropic"

	const providerSettings = host.contextProxy.getProviderSettings()

	if (!providerSettings.apiProvider) {
		providerSettings.apiProvider = apiProvider
	}

	const baseState = Object.fromEntries(
		Object.entries(STATE_FIELD_DEFAULTS).map(([key, defaultValue]) => [
			key,
			stateValues[key as keyof typeof stateValues] ?? defaultValue,
		]),
	) as unknown as Partial<ClineProviderState>

	const organizationAllowList = ORGANIZATION_ALLOW_ALL
	const cloudUserInfo = null
	const cloudIsAuthenticated = false
	const sharingEnabled = false
	const publicSharingEnabled = false
	const organizationSettingsVersion = -1
	const taskSyncEnabled = false

	return {
		...baseState,
		language: stateValues.language ?? formatLanguage(vscode.env.language),
		terminalShellIntegrationTimeout:
			stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
		apiConfiguration: providerSettings,
		lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
		customInstructions: stateValues.customInstructions,
		apiModelId: stateValues.apiModelId,
		allowedMaxRequests: stateValues.allowedMaxRequests,
		allowedMaxCost: stateValues.allowedMaxCost,
		taskHistory: host.taskHistory.initialized ? host.taskHistoryStore.getAll() : [],
		allowedCommands: stateValues.allowedCommands,
		deniedCommands: stateValues.deniedCommands,
		mcpServers: host.mcpHub?.getAllServers() ?? [],
		enhancementApiConfigId: stateValues.enhancementApiConfigId,
		customModes,
		disabledTools: stateValues.disabledTools,
		customCondensingPrompt: stateValues.customCondensingPrompt,
		codebaseIndexConfig: resolveCodebaseIndexConfig(stateValues),
		lockApiConfigAcrossModes: host.lockApiConfigAcrossModes,
		cloudUserInfo,
		cloudIsAuthenticated,
		sharingEnabled,
		publicSharingEnabled,
		organizationAllowList,
		organizationSettingsVersion,
		taskSyncEnabled,
		imageGenerationProvider: stateValues.imageGenerationProvider,
		openRouterImageApiKey: stateValues.openRouterImageApiKey,
		openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
	} as ClineProviderState
}

export async function buildWebviewState(
	host: IWebviewStateHost,
	state: ClineProviderState,
	commandLists: { allowedCommands: string[]; deniedCommands: string[] },
): Promise<ExtensionState> {
	const { allowedCommands, deniedCommands } = commandLists
	const cloudOrganizations: ExtensionState["cloudOrganizations"] = []
	const workspaceWebviewConfig = getWorkspaceWebviewConfig()
	const currentTask = host.getCurrentTask()

	return {
		...state,
		version: host.extensionVersion,
		permissionMode: computePermissionMode(state),
		uriScheme: vscode.env.uriScheme,
		currentTaskId: currentTask?.taskId,
		currentTaskItem: currentTask?.taskId ? host.taskHistoryStore.get(currentTask.taskId) : undefined,
		clineMessages: currentTask?.clineMessages || [],
		currentTaskTodos: currentTask?.todoList || [],
		messageQueue: currentTask?.messageQueueService?.messages,
		taskHistory: host.taskHistory.initialized
			? host.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task)
			: [],
		shouldShowAnnouncement: state.lastShownAnnouncementId !== host.latestAnnouncementId,
		allowedCommands,
		deniedCommands,
		cwd: host.cwd,
		renderContext: host.renderContext,
		settingsImportedAt: host.settingsImportedAt,
		cloudAuthSkipModel: host.cloudAuthSkipModel,
		cloudOrganizations,
		codebaseIndexConfig: resolveCodebaseIndexConfig(state),
		hasOpenedModeSelector: host.settingsManager.getGlobalValue("hasOpenedModeSelector") ?? false,
		openAiCodexIsAuthenticated: await getOpenAiCodexAuthState(),
		...workspaceWebviewConfig,
	} as ExtensionState
}

export function getAppProperties(host: IWebviewStateHost): StaticAppProperties {
	const packageJSON = host.extensionPackageJSON

	return {
		appName: packageJSON?.name ?? Package.name,
		appVersion: packageJSON?.version ?? Package.version,
		vscodeVersion: vscode.version,
		platform: process.platform,
		editorName: vscode.env.appName,
	}
}

export function getCloudProperties(): Record<string, unknown> {
	return {}
}

export async function getTaskProperties(
	host: IWebviewStateHost,
	state: ClineProviderState,
): Promise<DynamicAppProperties & TaskProperties> {
	const task = host.getCurrentTask()
	const todoList = task?.todoList
	let todos: { total: number; completed: number; inProgress: number; pending: number } | undefined

	if (todoList && todoList.length > 0) {
		todos = {
			total: todoList.length,
			completed: todoList.filter((todo) => todo.status === "completed").length,
			inProgress: todoList.filter((todo) => todo.status === "in_progress").length,
			pending: todoList.filter((todo) => todo.status === "pending").length,
		}
	}

	const apiProvider = state.apiConfiguration?.apiProvider

	return {
		language: state.language,
		mode: state.mode,
		taskId: task?.taskId,
		parentTaskId: task?.parentTaskId,
		apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
		modelId: task?.api?.getModel().id,
		diffStrategy: task?.diffStrategy?.getName(),
		isSubtask: task ? !!task.parentTaskId : undefined,
		...(todos && { todos }),
	}
}

export async function getGitProperties(): Promise<GitProperties> {
	return getWorkspaceGitInfo()
}

export async function getTelemetryProperties(
	host: IWebviewStateHost,
	state: ClineProviderState,
): Promise<TelemetryProperties> {
	return {
		...getAppProperties(host),
		...getCloudProperties(),
		...(await getTaskProperties(host, state)),
		...(await getGitProperties()),
	}
}
