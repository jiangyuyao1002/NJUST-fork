import os from "os"
import * as path from "path"
import fs from "fs/promises"
import EventEmitter from "events"


import delay from "delay"
import axios from "axios"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import type { McpServer } from "@njust-ai-cj/types"
import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type GlobalState,
	type ProviderName,
	type ProviderSettings,
	type NJUST_AI_CJSettings,
	type ProviderSettingsEntry,
	type StaticAppProperties,
	type DynamicAppProperties,
	type TaskProperties,
	type GitProperties,
	type TelemetryProperties,
	type TelemetryPropertiesProvider,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	type CreateTaskOptions,
	type ExtensionMessage,
	type ExtensionState,
	NJUST_AI_CJEventName,
	requestyDefaultModelId,
	openRouterDefaultModelId,
	DEFAULT_WRITE_DELAY_MS,
	DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
	DEFAULT_REQUEST_DELAY_SECONDS,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_MAX_OPEN_TABS_CONTEXT,
	ORGANIZATION_ALLOW_ALL,
	DEFAULT_MODES,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	getModelId,
	isRetiredProvider,
} from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { Package } from "../../shared/package"
import { formatLanguage } from "../../shared/language"
import { findLast } from "../../shared/array"
import { supportPrompt } from "../../shared/support-prompt"

import { Mode, defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { experimentDefault } from "../../shared/experiments"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"
import { ProfileValidator } from "../../shared/ProfileValidator"

import { Terminal } from "../../integrations/terminal/Terminal"

import { getTheme } from "../../integrations/theme/getTheme"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import { McpServerManager } from "../../services/mcp/McpServerManager"
import type { IMcpHubService } from "../../services/mcp/interfaces/IMcpHubService"

import { CodeIndexManager } from "../../services/code-index/manager"
import { cangjieDiagnosticModeSwitch } from "../../services/cangjie-lsp/cangjieDiagnosticModeSwitch"

import type { IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"


import { setTtsEnabled, setTtsSpeed } from "../../utils/tts"
import { getWorkspaceGitInfo } from "../../utils/git"
import { getWorkspacePath } from "../../utils/path"
import { OrganizationAllowListViolationError } from "../../utils/errors"

import { setPanel } from "../../activate/registerCommands"

import { t } from "../../i18n"

import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task } from "../task/Task"
import type { ITaskHost } from "../task/interfaces/ITaskHost"
import type { IMcpHubClient } from "../../services/mcp/interfaces/IMcpHubClient"
import { PlanEngine } from "../agent/PlanEngine"
import { AgentOrchestrator } from "../agent/AgentOrchestrator"

import { WebviewMessageRouter } from "./WebviewMessageRouter"
import { PendingEditManager } from "./PendingEditManager"
import { WebviewContentProvider } from "./WebviewContentProvider"
import { mergeAllowedCommands, mergeDeniedCommands } from "./commandListUtils"
import { TaskStackManager } from "./TaskStackManager"
import { TaskHistoryService, type TaskHistoryHost } from "./TaskHistoryService"
import type { ClineMessage, TodoItem } from "@njust-ai-cj/types"
import { readApiMessages, saveApiMessages, saveTaskMessages, TaskHistoryStore } from "../task-persistence"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"
import { logger } from "../../shared/logger"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ClineProviderEvents = {
	clineCreated: [cline: Task]
}

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements
		vscode.WebviewViewProvider,
		TelemetryPropertiesProvider,
		TaskProviderLike,
		ITaskHost,
		IMcpHubClient
{
	// Used in package.json as the view's id. This value cannot be changed due
	// to how VSCode caches views based on their id, and updating the id would
	// break existing instances of the extension.
	public static readonly sideBarId = `${Package.name}.SidebarProvider`
	public static readonly tabPanelId = `${Package.name}.TabPanelProvider`
	private static activeInstances: Set<ClineProvider> = new Set()
	private disposables: vscode.Disposable[] = []
	private webviewDisposables: vscode.Disposable[] = []
	private readonly messageRouter: WebviewMessageRouter
	private view?: vscode.WebviewView | vscode.WebviewPanel
	public readonly stack: TaskStackManager
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: CodeIndexManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	protected mcpHub?: IMcpHubService // Change from private to protected
	protected skillsManager?: SkillsManager
	private taskCreationCallback: (task: Task) => void
	private currentWorkspacePath: string | undefined
	private _disposed = false

	public readonly taskHistoryStore: TaskHistoryStore
	public readonly taskHistory: TaskHistoryService
	private readonly pendingEditManager: PendingEditManager
	private readonly webviewContentProvider: WebviewContentProvider

	/**
	 * Monotonically increasing sequence number for clineMessages state pushes.
	 * Used by the frontend to reject stale state that arrives out-of-order.
	 */
	private clineMessagesSeq = 0

	public isViewLaunched = false
	public settingsImportedAt?: number
	public readonly latestAnnouncementId = "mar-2026-v3.51.0-gpt-54-slash-skills" // v3.51.0 OpenAI GPT-5.4 support and slash command skills
	public readonly providerSettingsManager: ProviderSettingsManager
	public readonly customModesManager: CustomModesManager
	public readonly planEngine: PlanEngine
	public readonly agentOrchestrator: AgentOrchestrator

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
	) {
		super()
		this.currentWorkspacePath = getWorkspacePath()
		this.messageRouter = new WebviewMessageRouter(this)
		this.pendingEditManager = new PendingEditManager({ log: (msg) => this.log(msg) })
		this.webviewContentProvider = new WebviewContentProvider({
			extensionUri: this.contextProxy.extensionUri,
			getValues: () => this.contextProxy.getValues(),
		})

		this.stack = new TaskStackManager({
			outputChannel: this.outputChannel,
			emit: (event, ...args) => this.emit(event as any, ...args) as boolean,
			getState: () => this.getState(),
			getTaskWithId: (id) => this.getTaskWithId(id),
			updateTaskHistory: (item, options) => this.updateTaskHistory(item, options),
			createTaskWithHistoryItem: (historyItem, options) =>
				this.createTaskWithHistoryItem(historyItem, options),
			performPreparationTasks: (task) => this.performPreparationTasks(task),
		})

		ClineProvider.activeInstances.add(this)

		this.updateGlobalState("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Initialize the per-task file-based history store.
		// The globalState write-through is debounced separately (not on every mutation)
		// since per-task files are authoritative and globalState is only for downgrade compat.
		this.taskHistoryStore = new TaskHistoryStore(this.contextProxy.globalStorageUri.fsPath, {
			onWrite: async () => {
				this.taskHistory.scheduleGlobalStateWriteThrough()
			},
		})
		// Use Object.defineProperties with arrow function getters to preserve lexical `this`
		// (object-literal getters would bind `this` to the config object, not ClineProvider).
		this.taskHistory = new TaskHistoryService(
			Object.defineProperties({
				context: this.context,
				contextProxy: this.contextProxy as any,
				taskHistoryStore: this.taskHistoryStore,
				outputChannel: this.outputChannel,
				stack: this.stack,
				postMessageToWebview: (msg: ExtensionMessage) => this.postMessageToWebview(msg),
			} as TaskHistoryHost, {
				cwd: { get: () => this.cwd, enumerable: true, configurable: true },
				isViewLaunched: { get: () => this.isViewLaunched, enumerable: true, configurable: true },
			})
		)
		this.taskHistory.initialize().catch((error) => {
			this.log(`Failed to initialize TaskHistoryStore: ${error}`)
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		this._workspaceTracker = new WorkspaceTracker(this)

		this.providerSettingsManager = new ProviderSettingsManager(this.context)
		this.providerSettingsManager.initialize().catch((error) => {
			console.error("[ClineProvider] Failed to initialize ProviderSettingsManager:", error)
		})

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		McpServerManager.getInstance(this.context, this)
			.then((hub) => {
				this.mcpHub = hub
				if (this.mcpHub) {
					this.mcpHub.registerClient()
				}
			})
			.catch((error) => {
				this.log(`Failed to initialize MCP Hub: ${error}`)
			})

		this.planEngine = new PlanEngine(this, this.outputChannel)
		this.agentOrchestrator = new AgentOrchestrator(this, this.outputChannel)

		// Initialize Skills Manager for skill discovery
		this.skillsManager = new SkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(NJUST_AI_CJEventName.TaskCreated, instance)
			this.stack.bindEventForwarders(instance)
		}
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		return super.off(event, listener as any)
	}

	public async initializeCloudProfileSyncWhenReady(): Promise<void> {}


	async performPreparationTasks(cline: Task) {
		// LMStudio: We need to force model loading in order to read its context
		// size; we do it now since we're starting a task with that model selected.
		if (cline.apiConfiguration && cline.apiConfiguration.apiProvider === "lmstudio") {
			try {
				if (!hasLoadedFullDetails(cline.apiConfiguration.lmStudioModelId!)) {
					await forceFullModelDetailsLoad(
						cline.apiConfiguration.lmStudioBaseUrl ?? "http://localhost:1234",
						cline.apiConfiguration.lmStudioModelId!,
					)
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				this.log(`Failed to load full model details for LM Studio: ${msg}`)
				vscode.window.showErrorMessage(msg)
			}
		}
	}


	// Pending Edit Operations Management

	/**
	 * Sets a pending edit operation with automatic timeout cleanup
	 */
	public setPendingEditOperation(
		operationId: string,
		editData: {
			messageTs: number
			editedContent: string
			images?: string[]
			messageIndex: number
			apiConversationHistoryIndex: number
		},
	): void {
		this.pendingEditManager.set(operationId, editData)
	}

	/*
	VSCode extensions use the disposable pattern to clean up resources when the sidebar/editor tab is closed by the user or system. This applies to event listening, commands, interacting with the UI, etc.
	- https://vscode-docs.readthedocs.io/en/stable/extensions/patterns-and-principles/
	- https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	*/
	private clearWebviewResources() {
		while (this.webviewDisposables.length) {
			const x = this.webviewDisposables.pop()
			if (x) {
				x.dispose()
			}
		}
	}

	async dispose() {
		if (this._disposed) {
			return
		}

		this._disposed = true
		this.log("Disposing ClineProvider...")

		// Clear all tasks from the stack.
		while (this.stack.size > 0) {
			await this.stack.pop()
		}

		this.log("Cleared all tasks")

		// Clear all pending edit operations to prevent memory leaks
		this.pendingEditManager.clearAll()
		this.log("Cleared pending operations")

		if (this.view && "dispose" in this.view) {
			this.view.dispose()
			this.log("Disposed webview")
		}

		this.messageRouter.dispose()
		this.clearWebviewResources()

		while (this.disposables.length) {
			const x = this.disposables.pop()

			if (x) {
				x.dispose()
			}
		}

		this._workspaceTracker?.dispose()
		this._workspaceTracker = undefined
		await this.mcpHub?.unregisterClient()
		this.mcpHub = undefined
		await this.skillsManager?.dispose()
		this.skillsManager = undefined
		this.customModesManager?.dispose()
		this.taskHistoryStore.dispose()
		this.taskHistory.flushGlobalStateWriteThrough()
		this.log("Disposed all disposables")
		ClineProvider.activeInstances.delete(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		McpServerManager.unregisterProvider(this)
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		return findLast(Array.from(this.activeInstances), (instance) => instance.view?.visible === true)
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		let visibleProvider = ClineProvider.getVisibleInstance()

		// If no visible provider, try to show the sidebar view
		if (!visibleProvider) {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
			// Wait briefly for the view to become visible
			await delay(100)
			visibleProvider = ClineProvider.getVisibleInstance()
		}

		// If still no visible provider, return
		if (!visibleProvider) {
			return
		}

		return visibleProvider
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		// Check if there is a cline instance in the stack (if this provider has an active task)
		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | any[]>,
	): Promise<void> {
		// Capture telemetry for code action usage
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()

		// TODO: Improve type safety for promptType.
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "addToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		await visibleProvider.createTask(prompt)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | any[]>,
	): Promise<void> {
		TelemetryService.instance.captureCodeActionUsed(promptType)

		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return
		}

		const { customSupportPrompts } = await visibleProvider.getState()
		const prompt = supportPrompt.create(promptType, params, customSupportPrompts)

		if (command === "terminalAddToContext") {
			await visibleProvider.postMessageToWebview({
				type: "invoke",
				invoke: "setChatBoxMessage",
				text: `${prompt}\n\n`,
			})
			await visibleProvider.postMessageToWebview({ type: "action", action: "focusInput" })
			return
		}

		try {
			await visibleProvider.createTask(prompt)
		} catch (error) {
			if (error instanceof OrganizationAllowListViolationError) {
				// Errors from terminal commands seem to get swallowed / ignored.
				vscode.window.showErrorMessage(error.message)
			}

			throw error
		}
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		this.view = webviewView
		const inTabMode = this.configureWebviewPanelMode(webviewView)

		await this.initializeWebviewRuntimeState()
		await this.configureWebviewContent(webviewView)
		this.messageRouter.setWebviewMessageListener(webviewView.webview)
		this.webviewDisposables.push(...this.messageRouter.getDisposables())
		this.updateCodeIndexStatusSubscription()
		this.attachWebviewLifecycleListeners(webviewView, inTabMode)

		// If the extension is starting a new session, clear previous task state.
		// But don't clear if there's already an active task (e.g., resumed via IPC/bridge).
		const currentTask = this.getCurrentTask()
		if (!currentTask || currentTask.abandoned || currentTask.abort) {
			await this.stack.pop()
		}
	}

	private configureWebviewPanelMode(webviewView: vscode.WebviewView | vscode.WebviewPanel): boolean {
		const inTabMode = "onDidChangeViewState" in webviewView
		if (inTabMode) {
			setPanel(webviewView, "tab")
		} else if ("onDidChangeVisibility" in webviewView) {
			setPanel(webviewView, "sidebar")
		}
		return inTabMode
	}

	private async initializeWebviewRuntimeState(): Promise<void> {
		const {
			terminalShellIntegrationTimeout = Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled = false,
			terminalCommandDelay = 0,
			terminalZshClearEolMark = true,
			terminalZshOhMy = false,
			terminalZshP10k = false,
			terminalPowershellCounter = false,
			terminalZdotdir = false,
			ttsEnabled,
			ttsSpeed,
		} = await this.getState()

		Terminal.setShellIntegrationTimeout(terminalShellIntegrationTimeout)
		Terminal.setShellIntegrationDisabled(terminalShellIntegrationDisabled)
		Terminal.setCommandDelay(terminalCommandDelay)
		Terminal.setTerminalZshClearEolMark(terminalZshClearEolMark)
		Terminal.setTerminalZshOhMy(terminalZshOhMy)
		Terminal.setTerminalZshP10k(terminalZshP10k)
		Terminal.setPowershellCounter(terminalPowershellCounter)
		Terminal.setTerminalZdotdir(terminalZdotdir)
		setTtsEnabled(ttsEnabled ?? false)
		setTtsSpeed(ttsSpeed ?? 1)

		await this.contextProxy.setValue("enableWebSearch", false)
	}

	private async configureWebviewContent(webviewView: vscode.WebviewView | vscode.WebviewPanel): Promise<void> {
		const resourceRoots = [this.contextProxy.extensionUri]
		if (vscode.workspace.workspaceFolders) {
			resourceRoots.push(...vscode.workspace.workspaceFolders.map((folder) => folder.uri))
		}

		webviewView.webview.options = { enableScripts: true, localResourceRoots: resourceRoots }
		webviewView.webview.html =
			this.contextProxy.extensionMode === vscode.ExtensionMode.Development
				? await this.webviewContentProvider.getHMRHtmlContent(webviewView.webview)
				: await this.webviewContentProvider.getHtmlContent(webviewView.webview)
	}

	private attachWebviewLifecycleListeners(
		webviewView: vscode.WebviewView | vscode.WebviewPanel,
		inTabMode: boolean,
	): void {
		const activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
			this.updateCodeIndexStatusSubscription()
		})
		this.webviewDisposables.push(activeEditorSubscription)

		if ("onDidChangeViewState" in webviewView) {
			const viewStateDisposable = webviewView.onDidChangeViewState(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})
			this.webviewDisposables.push(viewStateDisposable)
		} else if ("onDidChangeVisibility" in webviewView) {
			const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
				if (this.view?.visible) {
					this.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
				}
			})
			this.webviewDisposables.push(visibilityDisposable)
		}

		webviewView.onDidDispose(
			async () => {
				if (inTabMode) {
					this.log("Disposing ClineProvider instance for tab view")
					await this.dispose()
				} else {
					this.log("Clearing webview resources for sidebar view")
					this.clearWebviewResources()
					this.codeIndexManager = undefined
				}
			},
			null,
			this.disposables,
		)

		const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e && e.affectsConfiguration("workbench.colorTheme")) {
				await this.postMessageToWebview({ type: "theme", text: JSON.stringify(await getTheme()) })
			}
		})
		this.webviewDisposables.push(configDisposable)
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	) {
		const isCliRuntime = process.env.ROO_CLI_RUNTIME === "1"
		const skipProfileRestoreFromHistory = isCliRuntime
		const isRehydratingCurrentTask = this.getCurrentTask()?.taskId === historyItem.id

		if (!isRehydratingCurrentTask) {
			await this.stack.pop()
		}

		await this.restoreHistoryModeAndProfile(historyItem, skipProfileRestoreFromHistory)

		const task = await this.createTaskInstanceFromHistory(historyItem, options)

		if (isRehydratingCurrentTask) {
			await this.stack.rehydrate(task)
		} else {
			await this.stack.push(task)
			this.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		await this.applyPendingEditIfPresent(task)
		return task
	}

	private async restoreHistoryModeAndProfile(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		skipProfileRestoreFromHistory: boolean,
	): Promise<void> {
		if (historyItem.mode) {
			const customModes = await this.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined
			if (!modeExists) {
				this.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}
			await this.updateGlobalState("mode", historyItem.mode)
			const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				await this.restoreModeBoundProfile(historyItem.mode)
			}
		}

		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			await this.restoreTaskBoundProfile(historyItem.apiConfigName)
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			this.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}
	}

	private async restoreModeBoundProfile(mode: string): Promise<void> {
		const [savedConfigId, listApiConfig] = await Promise.all([
			this.providerSettingsManager.getModeConfigId(mode),
			this.providerSettingsManager.listConfig(),
		])
		await this.updateGlobalState("listApiConfigMeta", listApiConfig)
		if (!savedConfigId) {
			return
		}
		const profile = listApiConfig.find(({ id }) => id === savedConfigId)
		if (!profile?.name) {
			return
		}
		try {
			const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
			if (fullProfile.apiProvider) {
				await this.activateProviderProfile({ name: profile.name })
			}
		} catch (error) {
			this.log(
				`Failed to restore API configuration for mode '${mode}': ${
					error instanceof Error ? error.message : String(error)
				}. Continuing with default configuration.`,
			)
		}
	}

	private async restoreTaskBoundProfile(apiConfigName: string): Promise<void> {
		const listApiConfig = await this.providerSettingsManager.listConfig()
		await this.updateGlobalState("listApiConfigMeta", listApiConfig)
		const profile = listApiConfig.find(({ name }) => name === apiConfigName)
		if (!profile?.name) {
			this.log(`Provider profile '${apiConfigName}' from history no longer exists. Using current configuration.`)
			return
		}
		try {
			await this.activateProviderProfile({ name: profile.name }, { persistModeConfig: false, persistTaskHistory: false })
		} catch (error) {
			this.log(
				`Failed to restore API configuration '${apiConfigName}' for task: ${
					error instanceof Error ? error.message : String(error)
				}. Continuing with current configuration.`,
			)
		}
	}

	private async createTaskInstanceFromHistory(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	): Promise<Task> {
		const { apiConfiguration, enableCheckpoints, checkpointTimeout, experiments } = await this.getState()
		return new Task({
			host: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			historyItem,
			experiments,
			rootTask: historyItem.rootTask,
			parentTask: historyItem.parentTask,
			taskNumber: historyItem.number,
			workspacePath: historyItem.workspace,
			onCreated: this.taskCreationCallback,
			startTask: options?.startTask ?? true,
			initialStatus: historyItem.status,
		})
	}


	private async applyPendingEditIfPresent(task: Task): Promise<void> {
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.pendingEditManager.get(operationId)
		if (!pendingEdit) {
			return
		}

		this.pendingEditManager.clear(operationId)
		this.log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)
		setTimeout(async () => {
			try {
				const { messageIndex, apiConversationHistoryIndex } = (() => {
					const messageIndex = task.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
					const apiConversationHistoryIndex = task.apiConversationHistory.findIndex((msg) => msg.ts === pendingEdit.messageTs)
					return { messageIndex, apiConversationHistoryIndex }
				})()
				if (messageIndex !== -1) {
					await task.overwriteClineMessages(task.clineMessages.slice(0, messageIndex))
					if (apiConversationHistoryIndex !== -1) {
						await task.overwriteApiConversationHistory(task.apiConversationHistory.slice(0, apiConversationHistoryIndex))
					}
					await task.handleWebviewAskResponse("messageResponse", pendingEdit.editedContent, pendingEdit.images)
				}
			} catch (error) {
				this.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
			}
		}, 100)
	}


	public async postMessageToWebview(message: ExtensionMessage) {
		if (this._disposed) {
			return
		}

		try {
			await this.view?.webview.postMessage(message)
		} catch {
			// View disposed, drop message silently
		}
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 */
	public async handleModeSwitch(newMode: Mode) {
		await this.clearCangjieDiagnosticsIfNeeded(newMode)
		await this.persistTaskModeSwitch(newMode)
		await this.updateGlobalState("mode", newMode)

		this.emit(NJUST_AI_CJEventName.ModeChanged, newMode)

		const lockApiConfigAcrossModes = this.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await this.postStateToWebview()
			return
		}

		await this.syncModeProviderProfile(newMode)
		await this.postStateToWebview()
	}

	private async clearCangjieDiagnosticsIfNeeded(newMode: Mode): Promise<void> {
		const previousMode = (await this.getGlobalState("mode")) as Mode | undefined
		if (previousMode === "cangjie" && newMode !== "cangjie") {
			cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()
		}
	}

	private async persistTaskModeSwitch(newMode: Mode): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
		task.emit(NJUST_AI_CJEventName.TaskModeSwitched, task.taskId, newMode)

		try {
			const taskHistoryItem =
				this.taskHistoryStore.get(task.taskId) ??
				(this.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await this.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
			}

			;(task as any)._taskMode = newMode
		} catch (error) {
			this.log(
				`Failed to persist mode switch for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
			)
			throw error
		}
	}

	private async syncModeProviderProfile(newMode: Mode): Promise<void> {
		const [savedConfigId, listApiConfig] = await Promise.all([
			this.providerSettingsManager.getModeConfigId(newMode),
			this.providerSettingsManager.listConfig(),
		])

		await this.updateGlobalState("listApiConfigMeta", listApiConfig)

		if (savedConfigId) {
			await this.activateModeSavedProfile(newMode, listApiConfig, savedConfigId)
			return
		}

		const currentApiConfigNameAfter = this.getGlobalState("currentApiConfigName")
		if (!currentApiConfigNameAfter) {
			return
		}

		const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)
		if (config?.id) {
			await this.providerSettingsManager.setModeConfig(newMode, config.id)
		}
	}

	private async activateModeSavedProfile(newMode: Mode, listApiConfig: ProviderSettingsEntry[], savedConfigId: string): Promise<void> {
		const profile = listApiConfig.find(({ id }) => id === savedConfigId)
		if (!profile?.name) {
			return
		}

		const fullProfile = await this.providerSettingsManager.getProfile({ name: profile.name })
		if (!fullProfile.apiProvider) {
			return
		}

		await this.activateProviderProfile({ name: profile.name })
	}

	// Provider Profile Management

	/**
	 * Updates the current task's API handler.
	 * Rebuilds when:
	 * - provider or model changes, OR
	 * - explicitly forced (e.g., user-initiated profile switch/save to apply changed settings like headers/baseUrl/tier).
	 * Always synchronizes task.apiConfiguration with latest provider settings.
	 * @param providerSettings The new provider settings to apply
	 * @param options.forceRebuild Force rebuilding the API handler regardless of provider/model equality
	 */
	private updateTaskApiHandlerIfNeeded(
		providerSettings: ProviderSettings,
		options: { forceRebuild?: boolean } = {},
	): void {
		const task = this.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const prevConfig = task.apiConfiguration
		const prevProvider = prevConfig?.apiProvider
		const prevModelId = prevConfig ? getModelId(prevConfig) : undefined
		const newProvider = providerSettings.apiProvider
		const newModelId = getModelId(providerSettings)

		const needsRebuild = forceRebuild || prevProvider !== newProvider || prevModelId !== newModelId

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			// No rebuild needed, just sync apiConfiguration
			;(task as any).apiConfiguration = providerSettings
		}
	}

	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return this.contextProxy.getValues().listApiConfigMeta || []
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.getProviderProfileEntries().find((profile) => profile.name === name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return !!this.getProviderProfileEntry(name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		try {
			// TODO: Do we need to be calling `activateProfile`? It's not
			// clear to me what the source of truth should be; in some cases
			// we rely on the `ContextProxy`'s data store and in other cases
			// we rely on the `ProviderSettingsManager`'s data store. It might
			// be simpler to unify these two.
			const id = await this.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await this.getState()

				// These promises do the following:
				// 1. Adds or updates the list of provider profiles.
				// 2. Sets the current provider profile.
				// 3. Sets the current mode's provider profile.
				// 4. Copies the provider settings to the context.
				//
				// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
				// this.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
				// We should probably switch to that and verify that it works.
				// I left the original implementation in just to be safe.
				await Promise.all([
					this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig()),
					this.updateGlobalState("currentApiConfigName", name),
					this.providerSettingsManager.setModeConfig(mode, id),
					this.contextProxy.setProviderSettings(providerSettings),
				])

				// Change the provider for the current task.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await this.persistStickyProviderProfileToCurrentTask(name)
			} else {
				await this.updateGlobalState("listApiConfigMeta", await this.providerSettingsManager.listConfig())
			}

			await this.postStateToWebview()
			return id
		} catch (error) {
			this.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry) {
		const globalSettings = this.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = this.getProviderProfileEntries().find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = this.getProviderProfileEntries().filter(({ name }) => name !== profileToDelete.name)

		await this.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await this.postStateToWebview()
	}

	private async persistStickyProviderProfileToCurrentTask(apiConfigName: string): Promise<void> {
		const task = this.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)
			await this.persistCurrentTaskProfileName(task.taskId, apiConfigName)
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			this.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	private async persistCurrentTaskProfileName(taskId: string, apiConfigName: string): Promise<void> {
		const taskHistoryItem =
			this.taskHistoryStore.get(taskId) ?? (this.getGlobalState("taskHistory") ?? []).find((item) => item.id === taskId)

		if (taskHistoryItem) {
			await this.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
		}
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	) {
		const { name, id, ...providerSettings } = await this.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true
		const listApiConfig = await this.providerSettingsManager.listConfig()

		await Promise.all([
			this.contextProxy.setValue("listApiConfigMeta", listApiConfig),
			this.contextProxy.setValue("currentApiConfigName", name),
			this.contextProxy.setProviderSettings(providerSettings),
		])

		await this.persistActivatedProfileModeBinding(id, persistModeConfig)
		this.updateTaskApiHandlerIfNeeded(providerSettings, { forceRebuild: true })

		if (persistTaskHistory) {
			await this.persistStickyProviderProfileToCurrentTask(name)
		}

		await this.postStateToWebview()

		if (providerSettings.apiProvider) {
			this.emit(NJUST_AI_CJEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

	private async persistActivatedProfileModeBinding(id: string | undefined, persistModeConfig: boolean): Promise<void> {
		if (!id || !persistModeConfig) {
			return
		}

		const { mode } = await this.getState()
		await this.providerSettingsManager.setModeConfig(mode, id)
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.updateGlobalState("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		// Get platform-specific application data directory
		let mcpServersDir: string
		if (process.platform === "win32") {
			// Windows: %APPDATA%\NJUST_AI_CJ\MCP
			mcpServersDir = path.join(os.homedir(), "AppData", "Roaming", "NJUST_AI_CJ", "MCP")
		} else if (process.platform === "darwin") {
			// macOS: ~/Documents/Cline/MCP
			mcpServersDir = path.join(os.homedir(), "Documents", "Cline", "MCP")
		} else {
			// Linux: ~/.local/share/Cline/MCP
			mcpServersDir = path.join(os.homedir(), ".local", "share", "NJUST_AI_CJ", "MCP")
		}

		try {
			await fs.mkdir(mcpServersDir, { recursive: true })
		} catch (_error) {
			// Fallback to a relative path if directory creation fails
			return path.join(os.homedir(), ".roo-code", "mcp")
		}
		return mcpServersDir
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		const { getSettingsDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath
		return getSettingsDirectoryPath(globalStoragePath)
	}

	// OpenRouter

	async handleOpenRouterCallback(code: string) {
		const { apiConfiguration, currentApiConfigName = "default" } = await this.getState()

		let apiKey: string

		try {
			const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
			// Extract the base domain for the auth endpoint.
			const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[1] || "https://openrouter.ai"
			const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, { code })

			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			this.log(
				`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			throw error
		}

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "openrouter",
			openRouterApiKey: apiKey,
			openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
		}

		await this.upsertProviderProfile(currentApiConfigName, newConfiguration)
	}

	// Requesty

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		const { apiConfiguration } = await this.getState()

		const newConfiguration: ProviderSettings = {
			...apiConfiguration,
			apiProvider: "requesty",
			requestyApiKey: code,
			requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
		}

		// set baseUrl as undefined if we don't provide one
		// or if it is the default requesty url
		if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
			newConfiguration.requestyBaseUrl = undefined
		} else {
			newConfiguration.requestyBaseUrl = baseUrl
		}

		const profileName = `Requesty (${new Date().toLocaleString()})`
		await this.upsertProviderProfile(profileName, newConfiguration)
	}

	// Task history

	async getTaskWithId(id: string) {
		return this.taskHistory.getTaskWithId(id)
	}

	async getTaskWithAggregatedCosts(taskId: string) {
		return this.taskHistory.getTaskWithAggregatedCosts(taskId)
	}

	async showTaskWithId(id: string): Promise<void> {
		await this.taskHistory.showTaskWithId(id, async (item) => {
			await this.createTaskWithHistoryItem(item)
		})
	}

	async exportTaskWithId(id: string) {
		await this.taskHistory.exportTaskWithId(id)
	}

	async condenseTaskContext(taskId: string) {
		await this.taskHistory.condenseTaskContext(taskId)
	}

	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true) {
		await this.taskHistory.deleteTaskWithId(id, cascadeSubtasks)
		await this.postStateToWebview()
	}

	async deleteTaskFromState(id: string) {
		await this.taskHistory.deleteTaskFromState(id)
		await this.postStateToWebview()
	}

	async refreshWorkspace() {
		this.currentWorkspacePath = getWorkspacePath()
		await this.postStateToWebview()
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		this.postMessageToWebview({ type: "state", state })
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		const { taskHistory: _omit, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		const state = await this.getStateToPostToWebview()
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		this.postMessageToWebview({ type: "state", state: rest })
	}

	private getMergedCommandLists(allowedCommands?: string[], deniedCommands?: string[]): { allowedCommands: string[]; deniedCommands: string[] } {
		const workspaceConfig = vscode.workspace.getConfiguration(Package.name)
		return {
			allowedCommands: mergeAllowedCommands(allowedCommands, workspaceConfig.get<string[]>("allowedCommands") || []),
			deniedCommands: mergeDeniedCommands(deniedCommands, workspaceConfig.get<string[]>("deniedCommands") || []),
		}
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const state = await this.getState()
		const commandLists = this.getMergedCommandLists(state.allowedCommands, state.deniedCommands)
		return await this.buildWebviewState(state, commandLists)
	}

	private async buildWebviewState(
		state: Awaited<ReturnType<ClineProvider["getState"]>>,
		commandLists: { allowedCommands: string[]; deniedCommands: string[] },
	): Promise<ExtensionState> {
		const { allowedCommands, deniedCommands } = commandLists
		const cloudOrganizations: any[] = []
		const workspaceConfig = vscode.workspace.getConfiguration(Package.name)
		const cloudAgentServerUrl = workspaceConfig.get<string>("cloudAgent.serverUrl", "http://120.79.250.232:8765") ?? "http://120.79.250.232:8765"
		const debug = workspaceConfig.get<boolean>("debug", false)
		const currentTask = this.getCurrentTask()

		return {
			version: this.context.extension?.packageJSON?.version ?? "",
			apiConfiguration: state.apiConfiguration,
			customInstructions: state.customInstructions,
			alwaysAllowReadOnly: state.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: state.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: state.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: state.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: state.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: state.alwaysAllowExecute ?? false,
			alwaysAllowMcp: state.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: state.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: state.alwaysAllowSubtasks ?? false,
			allowedMaxRequests: state.allowedMaxRequests,
			bypassWarningActive: (state.autoApprovalEnabled ?? false) &&
				(state.alwaysAllowExecute ?? false) &&
				(state.alwaysAllowWrite ?? false) &&
				(state.alwaysAllowWriteOutsideWorkspace ?? false) &&
				(state.alwaysAllowWriteProtected ?? false) &&
				(state.alwaysAllowReadOnly ?? false) &&
				(state.alwaysAllowReadOnlyOutsideWorkspace ?? false) &&
				(state.alwaysAllowMcp ?? false) &&
				(state.alwaysAllowModeSwitch ?? false) &&
				(state.alwaysAllowSubtasks ?? false) &&
				!((this.getGlobalState("bypassWarningDismissedAt") ?? 0) || false),
			allowedMaxCost: state.allowedMaxCost,
			autoCondenseContext: state.autoCondenseContext ?? true,
			autoCondenseContextPercent: state.autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
			uriScheme: vscode.env.uriScheme,
			currentTaskId: currentTask?.taskId,
			currentTaskItem: currentTask?.taskId ? this.taskHistoryStore.get(currentTask.taskId) : undefined,
			clineMessages: currentTask?.clineMessages || [],
			currentTaskTodos: currentTask?.todoList || [],
			messageQueue: currentTask?.messageQueueService?.messages,
			taskHistory: this.taskHistory.initialized ? this.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task) : [],
			soundEnabled: state.soundEnabled ?? false,
			ttsEnabled: state.ttsEnabled ?? false,
			ttsSpeed: state.ttsSpeed ?? 1.0,
			enableCheckpoints: state.enableCheckpoints ?? true,
			checkpointTimeout: state.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			enableWebSearch: state.enableWebSearch ?? false,
			enableStreamingToolExecution: state.enableStreamingToolExecution ?? true,
			webSearchProvider: state.webSearchProvider ?? "baidu-free",
			serpApiEngine: state.serpApiEngine ?? "bing",
			webSearchApiKey: state.webSearchApiKey ?? "",
			shouldShowAnnouncement: state.lastShownAnnouncementId !== this.latestAnnouncementId,
			allowedCommands,
			deniedCommands,
			soundVolume: state.soundVolume ?? 0.5,
			writeDelayMs: state.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			requestDelaySeconds: state.requestDelaySeconds ?? DEFAULT_REQUEST_DELAY_SECONDS,
			terminalOutputPreviewSize: state.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
			terminalShellIntegrationTimeout: state.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: state.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: state.terminalCommandDelay ?? 0,
			terminalPowershellCounter: state.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: state.terminalZshClearEolMark ?? true,
			terminalZshOhMy: state.terminalZshOhMy ?? false,
			terminalZshP10k: state.terminalZshP10k ?? false,
			terminalZdotdir: state.terminalZdotdir ?? false,
			mcpEnabled: state.mcpEnabled ?? true,
			currentApiConfigName: state.currentApiConfigName ?? "default",
			listApiConfigMeta: state.listApiConfigMeta ?? [],
			pinnedApiConfigs: state.pinnedApiConfigs ?? {},
			mode: state.mode ?? defaultModeSlug,
			customModePrompts: state.customModePrompts ?? {},
			customSupportPrompts: state.customSupportPrompts ?? {},
			enhancementApiConfigId: state.enhancementApiConfigId,
			autoApprovalEnabled: state.autoApprovalEnabled ?? false,
			customModes: state.customModes,
			experiments: state.experiments ?? experimentDefault,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			maxOpenTabsContext: state.maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT,
			maxWorkspaceFiles: state.maxWorkspaceFiles ?? 200,
			cwd: this.cwd,
			disabledTools: state.disabledTools,
			showRooIgnoredFiles: state.showRooIgnoredFiles ?? false,
			enableSubfolderRules: state.enableSubfolderRules ?? false,
			language: state.language ?? formatLanguage(vscode.env.language),
			fontFamily: state.fontFamily ?? "serif",
			renderContext: this.renderContext,
			maxImageFileSize: state.maxImageFileSize ?? 5,
			maxTotalImageSize: state.maxTotalImageSize ?? 20,
			settingsImportedAt: this.settingsImportedAt,
			historyPreviewCollapsed: state.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: state.reasoningBlockCollapsed ?? true,
			enterBehavior: state.enterBehavior ?? "send",
			cloudUserInfo: state.cloudUserInfo,
			cloudIsAuthenticated: state.cloudIsAuthenticated ?? false,
			cloudAuthSkipModel: this.context.globalState.get<boolean>("roo-auth-skip-model") ?? false,
			cloudOrganizations,
			sharingEnabled: state.sharingEnabled ?? false,
			publicSharingEnabled: state.publicSharingEnabled ?? false,
			organizationAllowList: state.organizationAllowList,
			organizationSettingsVersion: state.organizationSettingsVersion,
			customCondensingPrompt: state.customCondensingPrompt,
			codebaseIndexModels: state.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: state.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl: state.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider: state.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: state.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: state.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension: state.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension ?? 1536,
				codebaseIndexOpenAiCompatibleBaseUrl: state.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: state.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: state.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: state.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: state.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider: state.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: state.profileThresholds ?? {},
			hasOpenedModeSelector: this.getGlobalState("hasOpenedModeSelector") ?? false,
			lockApiConfigAcrossModes: state.lockApiConfigAcrossModes ?? false,
			alwaysAllowFollowupQuestions: state.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: state.followupAutoApproveTimeoutMs ?? 60000,
			includeDiagnosticMessages: state.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: state.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: state.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: state.includeCurrentTime ?? true,
			includeCurrentCost: state.includeCurrentCost ?? true,
			maxGitStatusFiles: state.maxGitStatusFiles ?? 0,
			taskSyncEnabled: state.taskSyncEnabled,
			imageGenerationProvider: state.imageGenerationProvider,
			openRouterImageApiKey: state.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: state.openRouterImageGenerationSelectedModel,
			openAiCodexIsAuthenticated: await (async () => {
				try {
					const { openAiCodexOAuthManager } = await import("../../integrations/openai-codex/oauth")
					return await openAiCodexOAuthManager.isAuthenticated()
				} catch {
					return false
				}
			})(),
			cloudAgentServerUrl,
			debug,
			saveAllBeforeExecuteCommand: workspaceConfig.get<boolean>("saveAllBeforeExecuteCommand", true),
			inlineCompletionEnabled: workspaceConfig.get<boolean>("inlineCompletion.enabled", true),
			inlineCompletionTriggerDelayMs: workspaceConfig.get<number>("inlineCompletion.triggerDelayMs", 300),
			inlineCompletionMaxLines: workspaceConfig.get<number>("inlineCompletion.maxLines", 10),
			inlineCompletionEnableCangjieEnhanced: workspaceConfig.get<boolean>(
				"inlineCompletion.enableCangjieEnhanced",
				true,
			),
			inlineCompletionTriggerCommand: workspaceConfig.get<string>("inlineCompletion.triggerCommand", "alt+\\"),
		}
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<
		Omit<
			ExtensionState,
			"clineMessages" | "renderContext" | "hasOpenedModeSelector" | "version" | "shouldShowAnnouncement"
		>
	> {
		const stateValues = this.contextProxy.getValues()
		const customModes = await this.customModesManager.getCustomModes()

		// Determine apiProvider with the same logic as before, while filtering retired providers.
		const apiProvider: ProviderName =
			stateValues.apiProvider && !isRetiredProvider(stateValues.apiProvider)
				? stateValues.apiProvider
				: "anthropic"

		// Build the apiConfiguration object combining state values and secrets.
		const providerSettings = this.contextProxy.getProviderSettings()

		// Ensure apiProvider is set properly if not already in state
		if (!providerSettings.apiProvider) {
			providerSettings.apiProvider = apiProvider
		}

		const organizationAllowList = ORGANIZATION_ALLOW_ALL
		const cloudUserInfo = null
		const cloudIsAuthenticated = false
		const sharingEnabled = false
		const publicSharingEnabled = false
		const organizationSettingsVersion = -1
		const taskSyncEnabled = false

		// Return the same structure as before.
		return {
			apiConfiguration: providerSettings,
			lastShownAnnouncementId: stateValues.lastShownAnnouncementId,
			customInstructions: stateValues.customInstructions,
			apiModelId: stateValues.apiModelId,
			alwaysAllowReadOnly: stateValues.alwaysAllowReadOnly ?? false,
			alwaysAllowReadOnlyOutsideWorkspace: stateValues.alwaysAllowReadOnlyOutsideWorkspace ?? false,
			alwaysAllowWrite: stateValues.alwaysAllowWrite ?? false,
			alwaysAllowWriteOutsideWorkspace: stateValues.alwaysAllowWriteOutsideWorkspace ?? false,
			alwaysAllowWriteProtected: stateValues.alwaysAllowWriteProtected ?? false,
			alwaysAllowExecute: stateValues.alwaysAllowExecute ?? false,
			alwaysAllowMcp: stateValues.alwaysAllowMcp ?? false,
			alwaysAllowModeSwitch: stateValues.alwaysAllowModeSwitch ?? false,
			alwaysAllowSubtasks: stateValues.alwaysAllowSubtasks ?? false,
			alwaysAllowFollowupQuestions: stateValues.alwaysAllowFollowupQuestions ?? false,
			followupAutoApproveTimeoutMs: stateValues.followupAutoApproveTimeoutMs ?? 60000,
			diagnosticsEnabled: stateValues.diagnosticsEnabled ?? true,
			allowedMaxRequests: stateValues.allowedMaxRequests,
			allowedMaxCost: stateValues.allowedMaxCost,
			autoCondenseContext: stateValues.autoCondenseContext ?? true,
			autoCondenseContextPercent: stateValues.autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
			taskHistory: this.taskHistory.initialized ? this.taskHistoryStore.getAll() : [],
			allowedCommands: stateValues.allowedCommands,
			deniedCommands: stateValues.deniedCommands,
			soundEnabled: stateValues.soundEnabled ?? false,
			ttsEnabled: stateValues.ttsEnabled ?? false,
			ttsSpeed: stateValues.ttsSpeed ?? 1.0,
			enableCheckpoints: stateValues.enableCheckpoints ?? true,
			checkpointTimeout: stateValues.checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
			enableWebSearch: stateValues.enableWebSearch ?? false,
			enableStreamingToolExecution: stateValues.enableStreamingToolExecution ?? true,
			webSearchProvider: stateValues.webSearchProvider ?? "baidu-free",
			serpApiEngine: stateValues.serpApiEngine ?? "bing",
			webSearchApiKey: stateValues.webSearchApiKey ?? "",
			soundVolume: stateValues.soundVolume,
			writeDelayMs: stateValues.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS,
			requestDelaySeconds: stateValues.requestDelaySeconds ?? DEFAULT_REQUEST_DELAY_SECONDS,
			terminalOutputPreviewSize: stateValues.terminalOutputPreviewSize ?? DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE,
			terminalShellIntegrationTimeout:
				stateValues.terminalShellIntegrationTimeout ?? Terminal.defaultShellIntegrationTimeout,
			terminalShellIntegrationDisabled: stateValues.terminalShellIntegrationDisabled ?? true,
			terminalCommandDelay: stateValues.terminalCommandDelay ?? 0,
			terminalPowershellCounter: stateValues.terminalPowershellCounter ?? false,
			terminalZshClearEolMark: stateValues.terminalZshClearEolMark ?? true,
			terminalZshOhMy: stateValues.terminalZshOhMy ?? false,
			terminalZshP10k: stateValues.terminalZshP10k ?? false,
			terminalZdotdir: stateValues.terminalZdotdir ?? false,
			mode: stateValues.mode ?? defaultModeSlug,
			// When the user has not chosen a language in settings, follow VS Code's display language (typically matches OS after install).
			language: stateValues.language ?? formatLanguage(vscode.env.language),
			fontFamily: stateValues.fontFamily ?? "serif",
			mcpEnabled: stateValues.mcpEnabled ?? true,
			mcpServers: this.mcpHub?.getAllServers() ?? [],
			currentApiConfigName: stateValues.currentApiConfigName ?? "default",
			listApiConfigMeta: stateValues.listApiConfigMeta ?? [],
			pinnedApiConfigs: stateValues.pinnedApiConfigs ?? {},
			modeApiConfigs: stateValues.modeApiConfigs ?? ({} as Record<Mode, string>),
			customModePrompts: stateValues.customModePrompts ?? {},
			customSupportPrompts: stateValues.customSupportPrompts ?? {},
			enhancementApiConfigId: stateValues.enhancementApiConfigId,
			experiments: stateValues.experiments ?? experimentDefault,
			autoApprovalEnabled: stateValues.autoApprovalEnabled ?? false,
			customModes,
			maxOpenTabsContext: stateValues.maxOpenTabsContext ?? DEFAULT_MAX_OPEN_TABS_CONTEXT,
			maxWorkspaceFiles: stateValues.maxWorkspaceFiles ?? 200,
			disabledTools: stateValues.disabledTools,
			showRooIgnoredFiles: stateValues.showRooIgnoredFiles ?? false,
			enableSubfolderRules: stateValues.enableSubfolderRules ?? false,
			maxImageFileSize: stateValues.maxImageFileSize ?? 5,
			maxTotalImageSize: stateValues.maxTotalImageSize ?? 20,
			historyPreviewCollapsed: stateValues.historyPreviewCollapsed ?? false,
			reasoningBlockCollapsed: stateValues.reasoningBlockCollapsed ?? true,
			enterBehavior: stateValues.enterBehavior ?? "send",
			cloudUserInfo,
			cloudIsAuthenticated,
			sharingEnabled,
			publicSharingEnabled,
			organizationAllowList,
			organizationSettingsVersion,
			customCondensingPrompt: stateValues.customCondensingPrompt,
			codebaseIndexModels: stateValues.codebaseIndexModels ?? EMBEDDING_MODEL_PROFILES,
			codebaseIndexConfig: {
				codebaseIndexEnabled: stateValues.codebaseIndexConfig?.codebaseIndexEnabled ?? false,
				codebaseIndexQdrantUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexQdrantUrl ?? "http://localhost:6333",
				codebaseIndexEmbedderProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderProvider ?? "openai",
				codebaseIndexEmbedderBaseUrl: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderBaseUrl ?? "",
				codebaseIndexEmbedderModelId: stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelId ?? "",
				codebaseIndexEmbedderModelDimension:
					stateValues.codebaseIndexConfig?.codebaseIndexEmbedderModelDimension,
				codebaseIndexOpenAiCompatibleBaseUrl:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenAiCompatibleBaseUrl,
				codebaseIndexSearchMaxResults: stateValues.codebaseIndexConfig?.codebaseIndexSearchMaxResults,
				codebaseIndexSearchMinScore: stateValues.codebaseIndexConfig?.codebaseIndexSearchMinScore,
				codebaseIndexBedrockRegion: stateValues.codebaseIndexConfig?.codebaseIndexBedrockRegion,
				codebaseIndexBedrockProfile: stateValues.codebaseIndexConfig?.codebaseIndexBedrockProfile,
				codebaseIndexOpenRouterSpecificProvider:
					stateValues.codebaseIndexConfig?.codebaseIndexOpenRouterSpecificProvider,
			},
			profileThresholds: stateValues.profileThresholds ?? {},
			lockApiConfigAcrossModes: this.context.workspaceState.get("lockApiConfigAcrossModes", false),
			includeDiagnosticMessages: stateValues.includeDiagnosticMessages ?? true,
			maxDiagnosticMessages: stateValues.maxDiagnosticMessages ?? 50,
			includeTaskHistoryInEnhance: stateValues.includeTaskHistoryInEnhance ?? true,
			includeCurrentTime: stateValues.includeCurrentTime ?? true,
			includeCurrentCost: stateValues.includeCurrentCost ?? true,
			maxGitStatusFiles: stateValues.maxGitStatusFiles ?? 0,
			taskSyncEnabled,
			imageGenerationProvider: stateValues.imageGenerationProvider,
			openRouterImageApiKey: stateValues.openRouterImageApiKey,
			openRouterImageGenerationSelectedModel: stateValues.openRouterImageGenerationSelectedModel,
		}
	}

	/**
	 * Updates a task in the task history and optionally broadcasts the updated history to the webview.
	 * Now delegates to TaskHistoryStore for per-task file persistence.
	 *
	 * @param item The history item to update or add
	 * @param options.broadcast Whether to broadcast the updated history to the webview (default: true)
	 * @returns The updated task history array
	 */
	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		return this.taskHistory.updateTaskHistory(item, options)
	}

	public async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		return this.taskHistory.broadcastTaskHistoryUpdate(history)
	}

	// ContextProxy

	// @deprecated - Use `ContextProxy#setValue` instead.
	private async updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]) {
		await this.contextProxy.setValue(key, value)
	}

	// @deprecated - Use `ContextProxy#getValue` instead.
	private getGlobalState<K extends keyof GlobalState>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof NJUST_AI_CJSettings>(key: K, value: NJUST_AI_CJSettings[K]) {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof NJUST_AI_CJSettings>(key: K) {
		return this.contextProxy.getValue(key)
	}

	public getValues() {
		return this.contextProxy.getValues()
	}

	public async setValues(values: NJUST_AI_CJSettings) {
		await this.contextProxy.setValues(values)
	}

	// dev

	async resetState() {
		const answer = await vscode.window.showInformationMessage(
			t("common:confirmation.reset_state"),
			{ modal: true },
			t("common:answers.yes"),
		)

		if (answer !== t("common:answers.yes")) {
			return
		}

		await this.contextProxy.resetAllState()
		await this.providerSettingsManager.resetAllConfigs()
		await this.customModesManager.resetCustomModes()
		await this.stack.pop()
		await this.postMessageToWebview({ type: "action", action: "resetLogin" })
		await this.postStateToWebview()
		await this.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	// logging

	public log(message: string) {
		this.outputChannel.appendLine(message)
		console.log(message)
	}

	// getters

	public get workspaceTracker(): WorkspaceTracker | undefined {
		return this._workspaceTracker
	}

	get viewLaunched() {
		return this.isViewLaunched
	}

	get messages() {
		return this.getCurrentTask()?.clineMessages || []
	}

	public getMcpHub(): IMcpHubService | undefined {
		return this.mcpHub
	}

	async onMcpServersUpdated(mcpServers: McpServer[]): Promise<void> {
		await this.postMessageToWebview({ type: "mcpServers", mcpServers })
	}

	getExtensionPackageVersion(): string {
		return this.context.extension.packageJSON.version ?? "1.0.0"
	}

	public getSkillsManager(): SkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): CodeIndexManager | undefined {
		return CodeIndexManager.getInstance(this.context)
	}

	/**
	 * Updates the code index status subscription to listen to the current workspace manager
	 */
	private updateCodeIndexStatusSubscription(): void {
		// Get the current workspace manager
		const currentManager = this.getCurrentWorkspaceCodeIndexManager()

		// If the manager hasn't changed, no need to update subscription
		if (currentManager === this.codeIndexManager) {
			return
		}

		// Dispose the old subscription if it exists
		if (this.codeIndexStatusSubscription) {
			this.codeIndexStatusSubscription.dispose()
			this.codeIndexStatusSubscription = undefined
		}

		// Update the current workspace manager reference
		this.codeIndexManager = currentManager

		// Subscribe to the new manager's progress updates if it exists
		if (currentManager) {
			this.codeIndexStatusSubscription = currentManager.onProgressUpdate((_update: IndexProgressUpdate) => {
				// Only send updates if this manager is still the current one
				if (currentManager === this.getCurrentWorkspaceCodeIndexManager()) {
					// Get the full status from the manager to ensure we have all fields correctly formatted
					const fullStatus = currentManager.getCurrentStatus()
					this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	public getCurrentTask(): Task | undefined {
		return this.stack.current
	}

	getTaskStackSize(): number {
		return this.stack.size
	}

	public getCurrentTaskStack(): string[] {
		return this.stack.taskIds
	}

	public getRecentTasks(): string[] {
		return this.taskHistory.getRecentTasks()
	}

	// When initializing a new task, (not from history but from a tool command
	// new_task) there is no need to remove the previous task since the new
	// task is a subtask of the previous one, and when it finishes it is removed
	// from the stack and the caller is resumed in this way we can have a chain
	// of tasks, each one being a sub task of the previous one until the main
	// task is finished.
	public async createTask(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: NJUST_AI_CJSettings = {},
	): Promise<Task> {
		if (configuration) {
			await this.setValues(configuration)

			if (configuration.allowedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("allowedCommands", configuration.allowedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.deniedCommands) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update("deniedCommands", configuration.deniedCommands, vscode.ConfigurationTarget.Global)
			}

			if (configuration.commandExecutionTimeout !== undefined) {
				await vscode.workspace
					.getConfiguration(Package.name)
					.update(
						"commandExecutionTimeout",
						configuration.commandExecutionTimeout,
						vscode.ConfigurationTarget.Global,
					)
			}

			if (configuration.currentApiConfigName) {
				await this.setProviderProfile(configuration.currentApiConfigName)
			}

			// Register custom modes so the CustomModesManager knows about them.
			// setValues writes to global state, but the manager overwrites that
			// when it merges .roomodes + global settings on refresh.  Persisting
			// via updateCustomMode ensures modes survive the merge cycle.
			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const { apiConfiguration, organizationAllowList, enableCheckpoints, checkpointTimeout, experiments } =
			await this.getState()

		// Single-open-task invariant: always enforce for user-initiated top-level tasks
		if (!parentTask) {
			try {
				await this.stack.pop()
			} catch {
				// Non-fatal
			}
		}

		if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = new Task({
			host: this,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: this.stack.root,
			parentTask,
			taskNumber: this.stack.size + 1,
			onCreated: this.taskCreationCallback,
			initialTodos: options.initialTodos,
			// Ensure this task is present in stack before startTask() emits
			// its initial state update, so state.currentTaskId is available ASAP.
			startTask: false,
			...options,
		})

		await this.stack.push(task)
		task.start()

		this.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTask(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		logger.info("ClineProvider", `cancelTask: cancelling task ${task.taskId}.${task.instanceId}`)

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			// During task startup there is a short window where currentTask exists
			// but task history has not been persisted yet. Cancelling should still
			// abort safely; we just skip post-cancel rehydration in that case.
			if (error instanceof Error && error.message === "Task not found") {
				this.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		// Preserve parent and root task information for history item.
		const rootTask = task.rootTask
		const parentTask = task.parentTask

		// Mark this as a user-initiated cancellation so provider-only rehydration can occur
		task.abortReason = "user_cancelled"

		// Capture the current instance to detect if rehydrate already occurred elsewhere
		const originalInstanceId = task.instanceId

		// Immediately cancel the underlying HTTP request if one is in progress
		// This ensures the stream fails quickly rather than waiting for network timeout
		task.cancelCurrentRequest()

		// Begin abort (non-blocking)
		task.abortTask()

		// Immediately mark the original instance as abandoned to prevent any residual activity
		task.abandoned = true

		await pWaitFor(
			() =>
				this.getCurrentTask()! === undefined ||
				this.getCurrentTask()!.isStreaming === false ||
				this.getCurrentTask()!.didFinishAbortingStream ||
				// If only the first chunk is processed, then there's no
				// need to wait for graceful abort (closes edits, browser,
				// etc).
				this.getCurrentTask()!.isWaitingForFirstChunk,
			{
				timeout: 3_000,
			},
		).catch(() => {
			logger.error("ClineProvider", "cancelTask: Failed to abort task")
		})

		// Defensive safeguard: if current instance already changed, skip rehydrate
		const current = this.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		// Final race check before rehydrate to avoid duplicate rehydration
		{
			const currentAfterCheck = this.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		// Clears task again, so we need to abortTask manually above.
		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		if (this.stack.size > 0) {
			const task = this.stack.current
			logger.info("ClineProvider", `clearTask: clearing task ${task?.taskId}.${task?.instanceId}`)
			await this.stack.pop()
		}
	}

	public resumeTask(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getModes(): Promise<{ slug: string; name: string }[]> {
		try {
			const customModes = await this.customModesManager.getCustomModes()
			return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
		} catch (_error) {
			return DEFAULT_MODES.map(({ slug, name }) => ({ slug, name }))
		}
	}

	public async getMode(): Promise<string> {
		const { mode } = await this.getState()
		return mode
	}

	public async setMode(mode: string): Promise<void> {
		await this.setValues({ mode })
	}

	// Provider Profiles

	public async getProviderProfiles(): Promise<{ name: string; provider?: string }[]> {
		const { listApiConfigMeta = [] } = await this.getState()
		return listApiConfigMeta.map((profile) => ({ name: profile.name, provider: profile.apiProvider }))
	}

	public async getProviderProfile(): Promise<string> {
		const { currentApiConfigName = "default" } = await this.getState()
		return currentApiConfigName
	}

	public async setProviderProfile(name: string): Promise<void> {
		await this.activateProviderProfile({ name })
	}

	// Telemetry

	private _appProperties?: StaticAppProperties
	private _gitProperties?: GitProperties

	private getAppProperties(): StaticAppProperties {
		if (!this._appProperties) {
			const packageJSON = this.context.extension?.packageJSON

			this._appProperties = {
				appName: packageJSON?.name ?? Package.name,
				appVersion: packageJSON?.version ?? Package.version,
				vscodeVersion: vscode.version,
				platform: process.platform,
				editorName: vscode.env.appName,
			}
		}

		return this._appProperties
	}

	public get appProperties(): StaticAppProperties {
		return this._appProperties ?? this.getAppProperties()
	}

	private getCloudProperties(): Record<string, unknown> {
		return {}
	}

	private async getTaskProperties(): Promise<DynamicAppProperties & TaskProperties> {
		const { language = "en", mode, apiConfiguration } = await this.getState()

		const task = this.getCurrentTask()
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

		const apiProvider = apiConfiguration?.apiProvider

		return {
			language,
			mode,
			taskId: task?.taskId,
			parentTaskId: task?.parentTaskId,
			apiProvider: apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
			modelId: task?.api?.getModel().id,
			diffStrategy: task?.diffStrategy?.getName(),
			isSubtask: task ? !!task.parentTaskId : undefined,
			...(todos && { todos }),
		}
	}

	private async getGitProperties(): Promise<GitProperties> {
		if (!this._gitProperties) {
			this._gitProperties = await getWorkspaceGitInfo()
		}

		return this._gitProperties
	}

	public get gitProperties(): GitProperties | undefined {
		return this._gitProperties
	}

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		return {
			...this.getAppProperties(),
			...this.getCloudProperties(),
			...(await this.getTaskProperties()),
			...(await this.getGitProperties()),
		}
	}

	public get cwd() {
		return this.currentWorkspacePath || getWorkspacePath()
	}

	/**
	 * Delegate parent task and open child task.
	 *
	 * - Enforce single-open invariant
	 * - Persist parent delegation metadata
	 * - Emit TaskDelegated (task-level; API forwards to provider/bridge)
	 * - Create child as sole active and switch mode to child's mode
	 */
	public async delegateParentAndOpenChild(params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
		isolationLevel?: string
		forkedContextSummary?: string
	}): Promise<Task> {
		const { parentTaskId, message, initialTodos, mode, isolationLevel, forkedContextSummary } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent (must be current task)
		const parent = this.getCurrentTask()
		if (!parent) {
			throw new Error("[delegateParentAndOpenChild] No current task")
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, current ${parent.taskId}`,
			)
		}
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				logger.warn("ClineProvider", `delegateParentAndOpenChild: Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					logger.error(
						"ClineProvider",
						`delegateParentAndOpenChild: CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}

		// 3) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await this.stack.pop({ skipDelegationRepair: true })
		} catch (error) {
			this.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}

		// 3) Switch provider mode to child's requested mode BEFORE creating the child task
		//    This ensures the child's system prompt and configuration are based on the correct mode.
		//    The mode switch must happen before createTask() because the Task constructor
		//    initializes its mode from provider.getState() during initializeTaskMode().
		try {
			await this.handleModeSwitch(mode as any)
		} catch (e) {
			this.log(
				`[delegateParentAndOpenChild] handleModeSwitch failed for mode '${mode}': ${
					(e as Error)?.message ?? String(e)
				}`,
			)
		}

		// 4) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and writing to globalState via saveClineMessages → updateTaskHistory)
		// before we persist the parent's delegation metadata in step 5.
		// Without this, the child's fire-and-forget startTask() races with step 5,
		// and the last writer to globalState overwrites the other's changes—
		// causing the parent's delegation fields to be lost.
		const child = await this.createTask(message, undefined, parent as any, {
			initialTodos,
			initialStatus: "active",
			startTask: false,
		})
		// Inherit streaming model snapshot for better prompt-cache/tool-schema reuse continuity.
		if (parent.cachedStreamingModel) {
			child.cachedStreamingModel = parent.cachedStreamingModel
		}

		// Apply forked isolation context if specified
		let effectiveForkedSummary = forkedContextSummary
		if (isolationLevel === "forked" && !effectiveForkedSummary) {
			// Auto-generate context summary from parent when caller (e.g. NewTaskTool)
			// requests forked isolation but doesn't provide a pre-built summary.
			try {
				const { generateParentContextSummary } = await import("../task/SubTaskContextBuilder")
				const { DEFAULT_FORKED_CONTEXT_CONFIG } = await import("../task/SubTaskOptions")
				if (parent.apiConversationHistory && parent.apiConversationHistory.length > 0) {
					effectiveForkedSummary = generateParentContextSummary(
						parent.apiConversationHistory,
						DEFAULT_FORKED_CONTEXT_CONFIG.summaryMaxTokens,
						DEFAULT_FORKED_CONTEXT_CONFIG,
					)
				}
			} catch (e) {
				this.log(
					`[delegateParentAndOpenChild] Failed to auto-generate forked context summary: ${
						(e as Error)?.message ?? String(e)
					}`,
				)
			}
		}
		if (isolationLevel === "forked" && effectiveForkedSummary) {
			child.forkedContextSummary = effectiveForkedSummary
			child.isolationLevel = "forked"
		}

		// 5) Persist parent delegation metadata BEFORE the child starts writing.
		try {
			const { historyItem } = await this.getTaskWithId(parentTaskId)
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), child.taskId]))
			const updatedHistory: typeof historyItem = {
				...historyItem,
				status: "delegated",
				delegatedToId: child.taskId,
				awaitingChildId: child.taskId,
				childIds,
			}
			await this.updateTaskHistory(updatedHistory)
		} catch (err) {
			this.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 6) Start the child task now that parent metadata is safely persisted.
		child.start()

		// 7) Emit TaskDelegated (provider-level)
		try {
			this.emit(NJUST_AI_CJEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch {
			// non-fatal
		}

		return child
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		const { parentTaskId, childTaskId, completionResultSummary } = params
		const globalStoragePath = this.contextProxy.globalStorageUri.fsPath

		// 1) Load parent from history and current persisted messages
		const { historyItem } = await this.getTaskWithId(parentTaskId)

		let parentClineMessages: ClineMessage[] = []
		try {
			parentClineMessages = await readTaskMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch {
			parentClineMessages = []
		}

		let parentApiMessages: any[] = []
		try {
			parentApiMessages = (await readApiMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})) as any[]
		} catch {
			parentApiMessages = []
		}

		// 2) Inject synthetic records: UI subtask_result and update API tool_result
		const ts = Date.now()

		// Defensive: ensure arrays
		if (!Array.isArray(parentClineMessages)) parentClineMessages = []
		if (!Array.isArray(parentApiMessages)) parentApiMessages = []

		const subtaskUiMessage: ClineMessage = {
			type: "say",
			say: "subtask_result",
			text: completionResultSummary,
			ts,
				id: crypto.randomUUID(),
		}
		parentClineMessages.push(subtaskUiMessage)
		await saveTaskMessages({ messages: parentClineMessages, taskId: parentTaskId, globalStoragePath })

		// Find the tool_use_id from the last assistant message's new_task tool_use
		let toolUseId: string | undefined
		for (let i = parentApiMessages.length - 1; i >= 0; i--) {
			const msg = parentApiMessages[i]
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && block.name === "new_task") {
						toolUseId = block.id
						break
					}
				}
				if (toolUseId) break
			}
		}

		// Preferred: if the parent history contains the native tool_use for new_task,
		// inject a matching tool_result for the Anthropic message contract:
		// user → assistant (tool_use) → user (tool_result)
		if (toolUseId) {
			// Check if the last message is already a user message with a tool_result for this tool_use_id
			// (in case this is a retry or the history was already updated)
			const lastMsg = parentApiMessages[parentApiMessages.length - 1]
			let alreadyHasToolResult = false
			if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
				for (const block of lastMsg.content) {
					if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
						// Update the existing tool_result content
						block.content = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
						alreadyHasToolResult = true
						break
					}
				}
			}

			// If no existing tool_result found, create a NEW user message with the tool_result
			if (!alreadyHasToolResult) {
				parentApiMessages.push({
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: toolUseId,
							content: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
						},
					],
					ts,
				})
			}

			// Validate the newly injected tool_result against the preceding assistant message.
			// This ensures the tool_result's tool_use_id matches a tool_use in the immediately
			// preceding assistant message (Anthropic API requirement).
			const lastMessage = parentApiMessages[parentApiMessages.length - 1]
			if (lastMessage?.role === "user") {
				const validatedMessage = validateAndFixToolResultIds(lastMessage, parentApiMessages.slice(0, -1))
				parentApiMessages[parentApiMessages.length - 1] = validatedMessage
			}
		} else {
			// If there is no corresponding tool_use in the parent API history, we cannot emit a
			// tool_result. Fall back to a plain user text note so the parent can still resume.
			parentApiMessages.push({
				role: "user",
				content: [
					{
						type: "text" as const,
						text: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
					},
				],
				ts,
			})
		}

		await saveApiMessages({ messages: parentApiMessages as any, taskId: parentTaskId, globalStoragePath })

		// 3) Close child instance if still open (single-open-task invariant).
		//    This MUST happen BEFORE updating the child's status to "completed" because
		//    stack.pop() → abortTask(true) → saveClineMessages() writes
		//    the historyItem with initialStatus (typically "active"), which would
		//    overwrite a "completed" status set earlier.
		const current = this.getCurrentTask()
		if (current?.taskId === childTaskId) {
			await this.stack.pop()
		}

		// 4) Update child metadata to "completed" status.
		//    This runs after the abort so it overwrites the stale "active" status
		//    that saveClineMessages() may have written during step 3.
		try {
			const { historyItem: childHistory } = await this.getTaskWithId(childTaskId)
			await this.updateTaskHistory({
				...childHistory,
				status: "completed",
			})
		} catch (err) {
			this.log(
				`[reopenParentFromDelegation] Failed to persist child completed status for ${childTaskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 5) Update parent metadata and persist BEFORE emitting completion event
		const childIds = Array.from(new Set([...(historyItem.childIds ?? []), childTaskId]))
		const updatedHistory: typeof historyItem = {
			...historyItem,
			status: "active",
			completedByChildId: childTaskId,
			completionResultSummary,
			awaitingChildId: undefined,
			childIds,
		}
		await this.updateTaskHistory(updatedHistory)

		// 6) Emit TaskDelegationCompleted (provider-level)
		try {
			this.emit(NJUST_AI_CJEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
		} catch {
			// non-fatal
		}

		// 7) Reopen the parent from history as the sole active task (restores saved mode)
		//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
		const parentInstance = await this.createTaskWithHistoryItem(updatedHistory, { startTask: false })

		// 8) Inject restored histories into the in-memory instance before resuming
		if (parentInstance) {
			try {
				await parentInstance.overwriteClineMessages(parentClineMessages)
			} catch {
				// non-fatal
			}
			try {
				await parentInstance.overwriteApiConversationHistory(parentApiMessages as any)
			} catch {
				// non-fatal
			}

			// Auto-resume parent without ask("resume_task")
			await parentInstance.resumeAfterDelegation()
		}

		// 9) Emit TaskDelegationResumed (provider-level)
		try {
			this.emit(NJUST_AI_CJEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		} catch {
			// non-fatal
		}
	}

	/**
	 * Convert a file path to a webview-accessible URI
	 * This method safely converts file paths to URIs that can be loaded in the webview
	 *
	 * @param filePath - The absolute file path to convert
	 * @returns The webview URI string, or the original file URI if conversion fails
	 * @throws {Error} When webview is not available
	 * @throws {TypeError} When file path is invalid
	 */
	public convertToWebviewUri(filePath: string): string {
		try {
			const fileUri = vscode.Uri.file(filePath)

			// Check if we have a webview available
			if (this.view?.webview) {
				const webviewUri = this.view.webview.asWebviewUri(fileUri)
				return webviewUri.toString()
			}

			// Specific error for no webview available
			logger.error("ClineProvider", "No webview available for URI conversion")
			// Fallback to file URI if no webview available
			return fileUri.toString()
		} catch (error) {
			// More specific error handling
			if (error instanceof TypeError) {
				logger.error("ClineProvider", "Invalid file path provided for URI conversion:", error)
			} else {
				logger.error("ClineProvider", "Failed to convert to webview URI:", error)
			}
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}

}
