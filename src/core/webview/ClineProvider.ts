import EventEmitter from "events"

import * as vscode from "vscode"

import type { McpServer } from "@njust-ai/types"
import {
	type TaskProviderLike,
	type TaskProviderEvents,
	type ProviderSettings,
	type NJUST_AISettings,
	type ProviderSettingsEntry,
	type TelemetryPropertiesProvider,
	type TelemetryProperties,
	type CodeActionId,
	type CodeActionName,
	type TerminalActionId,
	type TerminalActionPromptType,
	type HistoryItem,
	type CreateTaskOptions,
	type ExtensionMessage,
	type ExtensionState,
	type GlobalState,
	NJUST_AIEventName,
	DEFAULT_MODES,
	TelemetryEventName,
} from "@njust-ai/types"
import {} from "@njust-ai/core/providers"
import { TelemetryService } from "@njust-ai/telemetry"
import { Package } from "../../shared/package"

import { computePermissionMode, getMergedCommandLists } from "./ClineProviderState"
import { Mode } from "../../shared/modes"
import { EMBEDDING_MODEL_PROFILES } from "../../shared/embeddingModels"

import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import WorkspaceTracker from "../../integrations/workspace/WorkspaceTracker"

import type { IMcpHubService } from "../../services/mcp/interfaces/IMcpHubService"

import type { ICodeIndexManager, IndexProgressUpdate } from "../../services/code-index/interfaces/manager"
import type { ISkillsManager } from "../../services/skills/interfaces/ISkillsManager"
import type { IMemoryManager } from "../../services/memory/interfaces/IMemoryManager"
import type { IBypassStatusBar } from "../../services/interfaces/IBypassStatusBar"
import type { IClineProviderServices } from "../../services/interfaces/IClineProviderServices"
import type { IProfileStorageService } from "../../services/interfaces/IProfileStorageService"
import type { ICangjiePromptServices } from "../../services/interfaces/ICangjiePromptServices"
import { DefaultClineProviderServices } from "../../services/DefaultClineProviderServices"

import { getWorkspacePath } from "../../utils/path"

import { t } from "../../i18n"

import { forceFullModelDetailsLoad, hasLoadedFullDetails } from "../../api/providers/fetchers/lmstudio-full-details"

import { ContextProxy } from "../config/ContextProxy"
import { ProviderSettingsManager } from "../config/ProviderSettingsManager"
import { CustomModesManager } from "../config/CustomModesManager"
import { Task } from "../task/Task"
import type { ITaskHost } from "../task/interfaces/ITaskHost"
import type { ITaskDiffViewProvider } from "../task/interfaces/ITaskDiffViewProvider"
import type { IMcpHubClient } from "../../services/mcp/interfaces/IMcpHubClient"
import { PlanEngine } from "../agent/PlanEngine"
import { AgentOrchestrator } from "../agent/AgentOrchestrator"
import { taskEventBus, type DisposableLike } from "../events/TaskEventBus"
import { presentAssistantMessage } from "../assistant-message/presentAssistantMessage"
import {
	registerActionTarget,
	unregisterActionTarget,
	getVisibleInstance as _getVisibleInstance,
	getInstance as _getInstance,
	handleCodeAction,
	handleTerminalAction,
} from "../../activate/providerActionDispatcher"
import { registerUriCallbackHandler } from "../../activate/handleUri"

import { WebviewMessageRouter } from "./WebviewMessageRouter"
import { PendingEditManager } from "./PendingEditManager"
import { WebviewContentProvider } from "./WebviewContentProvider"
import { SettingsManager } from "./SettingsManager"
import { TaskCoordinator } from "./TaskCoordinator"
import { WebviewRouter } from "./WebviewRouter"
import { ClineProviderTaskManagement } from "./ClineProviderTaskManagement"
import { ClineProviderWebviewLifecycle } from "./ClineProviderWebviewLifecycle"
import {
	handleOpenRouterCallback as handleOpenRouterOAuth,
	handleRequestyCallback as handleRequestyOAuth,
} from "./OAuthCallbackHandler"
import {
	ensureMcpServersDirectoryExists as ensureMcpServersDir,
	ensureSettingsDirectoryExists as ensureSettingsDir,
} from "./providerPaths"

import { buildWebviewState, getState, getTelemetryProperties, type ClineProviderState } from "./WebviewStateBuilder"
import {
	activateProviderProfileWithProvider,
	deleteProviderProfileWithProvider,
	getProviderProfileEntriesWithProvider,
	getProviderProfileEntryWithProvider,
	handleModeSwitchWithProvider,
	hasProviderProfileEntryWithProvider,
	upsertProviderProfileWithProvider,
} from "./ClineProviderModeSync"
import {
	delegateParentAndOpenChildWithProvider,
	reopenParentFromDelegationWithProvider,
} from "./ClineProviderDelegation"
import { TaskStackManager } from "./TaskStackManager"
import { TaskHistoryService, type TaskHistoryHost } from "./TaskHistoryService"
import type { TodoItem } from "@njust-ai/types"
import { TaskHistoryStore } from "../task-persistence"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"

/**
 * https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
 * https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
 */

export type ClineProviderEvents = {
	clineCreated: [cline: Task]
}

export class ClineProvider
	extends EventEmitter<TaskProviderEvents>
	implements vscode.WebviewViewProvider, TelemetryPropertiesProvider, TaskProviderLike, ITaskHost, IMcpHubClient
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
	public readonly settingsManager: SettingsManager
	public readonly taskCoordinator: TaskCoordinator
	public readonly webviewRouter: WebviewRouter
	public view?: vscode.WebviewView | vscode.WebviewPanel
	public readonly stack: TaskStackManager
	private codeIndexStatusSubscription?: vscode.Disposable
	private codeIndexManager?: ICodeIndexManager
	private _workspaceTracker?: WorkspaceTracker // workSpaceTracker read-only for access outside this class
	public mcpHub?: IMcpHubService // Must be public to satisfy IWebviewStateHost
	protected skillsManager?: ISkillsManager
	private _memoryManager?: IMemoryManager
	private taskCreationCallback: (task: Task) => void
	private readonly assistantPresentationSubscription: DisposableLike
	private currentWorkspacePath: string | undefined
	private _disposed = false

	/** Pending OAuth state for CSRF + PKCE verification (set by webview, consumed by URI callback). */
	public pendingOAuthState?: {
		state: string
		codeVerifier?: string
		provider: "openrouter" | "requesty"
		expectedBaseUrl?: string
		createdAt: number
	}

	public readonly taskHistoryStore: TaskHistoryStore
	public readonly taskHistory: TaskHistoryService
	private readonly pendingEditManager: PendingEditManager
	private readonly webviewContentProvider: WebviewContentProvider
	private readonly bypassStatusBar: IBypassStatusBar
	private readonly taskManagement: ClineProviderTaskManagement
	private readonly webviewLifecycle: ClineProviderWebviewLifecycle

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

	/**
	 * Optional compile function injected by extension.ts when CangjieCompileGuard
	 * is available. Used by CloudAgentOrchestrator to run local cjpm builds.
	 */
	compileLocal?: (cwd: string) => Promise<{ success: boolean; output: string }>

	get cloudAuthSkipModel(): boolean {
		return this.context.globalState.get<boolean>("njust-ai-auth-skip-model") ?? false
	}

	get lockApiConfigAcrossModes(): boolean {
		return this.context.workspaceState.get("lockApiConfigAcrossModes", false)
	}

	get extensionVersion(): string {
		return this.context.extension?.packageJSON?.version ?? ""
	}

	get extensionPackageJSON(): { name?: string; version?: string } | undefined {
		return this.context.extension?.packageJSON
	}

	private readonly services: IClineProviderServices

	constructor(
		readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
		public readonly renderContext: "sidebar" | "editor" = "sidebar",
		public readonly contextProxy: ContextProxy,
		services?: IClineProviderServices,
	) {
		super()
		// Multiple consumers register TaskCreated and other events on this provider.
		// Set a generous limit to avoid Node's default 10-listener warning.
		this.setMaxListeners(30)
		this.currentWorkspacePath = getWorkspacePath()
		this.messageRouter = new WebviewMessageRouter(this)
		this.pendingEditManager = new PendingEditManager({ log: (msg) => this.log(msg) })
		this.webviewContentProvider = new WebviewContentProvider({
			extensionUri: this.contextProxy.extensionUri,
			getValues: () => this.contextProxy.getValues(),
		})
		this.settingsManager = new SettingsManager(this.contextProxy)
		this.webviewRouter = new WebviewRouter({
			isDisposed: () => this._disposed,
			getWebview: () => this.view?.webview,
			buildState: () => this.getStateToPostToWebview(),
		})
		this.services = services ?? new DefaultClineProviderServices()
		this.bypassStatusBar = this.services.createBypassStatusBar()

		this.stack = new TaskStackManager({
			outputChannel: this.outputChannel,
			emit: (event, ...args) => EventEmitter.prototype.emit.call(this, event, ...args) as boolean,
			getState: () => this.getState(),
			getTaskWithId: (id) => this.getTaskWithId(id),
			updateTaskHistory: (item, options) => this.updateTaskHistory(item, options),
			createTaskWithHistoryItem: (historyItem, options) => this.createTaskWithHistoryItem(historyItem, options),
			performPreparationTasks: (task) => this.performPreparationTasks(task),
		})

		ClineProvider.activeInstances.add(this)
		registerActionTarget(this)
		registerUriCallbackHandler(this)

		void this.settingsManager.setGlobalValue("codebaseIndexModels", EMBEDDING_MODEL_PROFILES)

		// Initialize the per-task file-based history store.
		// The globalState write-through is debounced separately (not on every mutation)
		// since per-task files are authoritative and globalState is only for downgrade compat.
		this.taskHistoryStore = new TaskHistoryStore(this.contextProxy.globalStorageUri.fsPath, {
			// eslint-disable-next-line @typescript-eslint/require-await
			onWrite: async () => {
				this.taskHistory.scheduleGlobalStateWriteThrough()
			},
		})
		// Use Object.defineProperties with arrow function getters to preserve lexical `this`
		// (object-literal getters would bind `this` to the config object, not ClineProvider).
		this.taskHistory = new TaskHistoryService(
			Object.defineProperties(
				{
					context: this.context,
					contextProxy: this.contextProxy as unknown as TaskHistoryHost["contextProxy"],
					taskHistoryStore: this.taskHistoryStore,
					outputChannel: this.outputChannel,
					stack: this.stack,
					postMessageToWebview: (msg: ExtensionMessage) => this.postMessageToWebview(msg),
				} as TaskHistoryHost,
				{
					cwd: { get: () => this.cwd, enumerable: true, configurable: true },
					isViewLaunched: { get: () => this.isViewLaunched, enumerable: true, configurable: true },
				},
			),
		)
		this.taskHistory.initialize().catch((error) => {
			this.log(`Failed to initialize TaskHistoryStore: ${error}`)
		})
		this.taskCoordinator = new TaskCoordinator({
			getCurrentTask: () => this.stack.current,
			getTaskStackSize: () => this.stack.size,
			getCurrentTaskStack: () => this.stack.taskIds,
			getRecentTasks: () => this.taskHistory.getRecentTasks(),
			createTask: (text, images, parentTask, options, configuration) =>
				this.createTaskInternal(text, images, parentTask, options, configuration),
			cancelTask: () => this.cancelTaskInternal(),
			clearTask: () => this.clearTaskInternal(),
			resumeTask: (taskId) => this.resumeTaskInternal(taskId),
			createTaskWithHistoryItem: (historyItem, options) => this.createTaskWithHistoryItem(historyItem, options),
		})

		// Start configuration loading (which might trigger indexing) in the background.
		// Don't await, allowing activation to continue immediately.

		this._workspaceTracker = new WorkspaceTracker(this)
		this._workspaceTracker.init?.()

		this.providerSettingsManager = new ProviderSettingsManager(this.context)
		this.providerSettingsManager.initialize().catch((error) => {
			logger.error("ClineProvider", "Failed to initialize ProviderSettingsManager:", error)
		})

		this.customModesManager = new CustomModesManager(this.context, async () => {
			await this.postStateToWebviewWithoutClineMessages()
		})

		// Initialize MCP Hub through the singleton manager
		this.services
			.getMcpHub(this.context, this)
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
		this.assistantPresentationSubscription = taskEventBus.on(
			"task:assistant-message-requested",
			async (_event, payload) => {
				const task = (payload.data as { task?: Task } | undefined)?.task
				if (!task || task.providerRef.deref() !== this) {
					return
				}
				await presentAssistantMessage(task)
			},
		)

		// Initialize Skills Manager for skill discovery
		this.skillsManager = this.services.createSkillsManager(this)
		this.skillsManager.initialize().catch((error) => {
			this.log(`Failed to initialize Skills Manager: ${error}`)
		})

		// Forward <most> task events to the provider.
		// We do something fairly similar for the IPC-based API.
		this.taskCreationCallback = (instance: Task) => {
			this.emit(NJUST_AIEventName.TaskCreated, instance)
			this.stack.bindEventForwarders(instance)
		}

		this.taskManagement = new ClineProviderTaskManagement({
			stack: this.stack,
			taskHistory: this.taskHistory,
			pendingEditManager: this.pendingEditManager,
			customModesManager: this.customModesManager,
			taskCreationCallback: (task) => this.taskCreationCallback(task),
			provider: this,
			getState: () => this.getState(),
			setValues: (config) => this.setValues(config),
			setProviderProfile: (name) => this.setProviderProfile(name),
			getTaskWithId: (id) => this.getTaskWithId(id),
			log: (msg) => this.log(msg),
		})

		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this
		this.webviewLifecycle = new ClineProviderWebviewLifecycle({
			contextProxy: this.contextProxy,
			webviewContentProvider: this.webviewContentProvider,
			webviewDisposables: this.webviewDisposables,
			disposables: this.disposables,
			get view() {
				return self.view
			},
			setView: (v) => {
				self.view = v
			},
			getState: () => this.getState(),
			postMessageToWebview: (msg) => this.postMessageToWebview(msg),
			updateCodeIndexStatusSubscription: () => this.updateCodeIndexStatusSubscription(),
			log: (msg) => this.log(msg),
			dispose: () => this.dispose(),
			clearCodeIndexManager: () => {
				this.codeIndexManager = undefined
			},
		})
	}

	/**
	 * Override EventEmitter's on method to match TaskProviderLike interface
	 */
	override on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return super.on(event, listener as any)
	}

	/**
	 * Override EventEmitter's off method to match TaskProviderLike interface
	 */
	override off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
				const msg = getErrorMessage(error)
				this.log(`Failed to load full model details for LM Studio: ${msg}`)
				TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
				vscode.window.showErrorMessage(msg)
			}
		}
	}

	createDiffViewProvider(cwd: string, task: unknown): ITaskDiffViewProvider {
		return new DiffViewProvider(cwd, task as Task)
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
		this.webviewLifecycle.clearWebviewResources()
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
		this.assistantPresentationSubscription.dispose()
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
		this.customModesManager?.dispose()
		this.taskHistoryStore.dispose()
		this.taskHistory.flushGlobalStateWriteThrough()
		this.log("Disposed all disposables")
		ClineProvider.activeInstances.delete(this)
		unregisterActionTarget(this)

		// Clean up any event listeners attached to this provider
		this.removeAllListeners()

		this.services.unregisterMcpProvider(this)
		await this.services.dispose()
	}

	public static getVisibleInstance(): ClineProvider | undefined {
		const instance = _getVisibleInstance()
		return instance as ClineProvider | undefined
	}

	public static async getInstance(): Promise<ClineProvider | undefined> {
		const instance = await _getInstance()
		return instance as ClineProvider | undefined
	}

	public static async isActiveTask(): Promise<boolean> {
		const visibleProvider = await ClineProvider.getInstance()

		if (!visibleProvider) {
			return false
		}

		if (visibleProvider.getCurrentTask()) {
			return true
		}

		return false
	}

	public static async handleCodeAction(
		command: CodeActionId,
		promptType: CodeActionName,
		params: Record<string, string | unknown[]>,
	): Promise<void> {
		await handleCodeAction(command, promptType, params)
	}

	public static async handleTerminalAction(
		command: TerminalActionId,
		promptType: TerminalActionPromptType,
		params: Record<string, string | unknown[]>,
	): Promise<void> {
		await handleTerminalAction(command, promptType, params)
	}

	async resolveWebviewView(webviewView: vscode.WebviewView | vscode.WebviewPanel) {
		await this.webviewLifecycle.resolveWebviewView(webviewView, this.messageRouter, this.stack, () =>
			this.getCurrentTask(),
		)
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	) {
		return this.taskManagement.createTaskWithHistoryItem(historyItem, options)
	}

	public async postMessageToWebview(message: ExtensionMessage) {
		await this.webviewRouter.postMessage(message)
	}

	public getGlobalState<K extends keyof GlobalState>(key: K): GlobalState[K] | undefined {
		return this.contextProxy.getValue(key)
	}

	public updateGlobalState<K extends keyof GlobalState>(key: K, value: GlobalState[K]): Promise<void> {
		return this.contextProxy.setValue(key, value)
	}

	/**
	 * Handle switching to a new mode, including updating the associated API configuration
	 * @param newMode The mode to switch to
	 */
	public async handleModeSwitch(newMode: Mode) {
		return handleModeSwitchWithProvider(this, newMode)
	}

	// Provider Profile Management

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
	getProviderProfileEntries(): ProviderSettingsEntry[] {
		return getProviderProfileEntriesWithProvider(this)
	}

	getProviderProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return getProviderProfileEntryWithProvider(this, name)
	}

	public hasProviderProfileEntry(name: string): boolean {
		return hasProviderProfileEntryWithProvider(this, name)
	}

	async upsertProviderProfile(
		name: string,
		providerSettings: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		return upsertProviderProfileWithProvider(this, name, providerSettings, activate)
	}

	async deleteProviderProfile(profileToDelete: ProviderSettingsEntry): Promise<void> {
		return deleteProviderProfileWithProvider(this, profileToDelete)
	}

	async activateProviderProfile(
		args: { name: string } | { id: string },
		options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
	): Promise<void> {
		return activateProviderProfileWithProvider(this, args, options)
	}

	async updateCustomInstructions(instructions?: string) {
		// User may be clearing the field.
		await this.settingsManager.setGlobalValue("customInstructions", instructions || undefined)
		await this.postStateToWebview()
	}

	// MCP

	async ensureMcpServersDirectoryExists(): Promise<string> {
		return ensureMcpServersDir()
	}

	async ensureSettingsDirectoryExists(): Promise<string> {
		return ensureSettingsDir(this.contextProxy.globalStorageUri)
	}

	// OpenRouter / Requesty OAuth callbacks — delegated to OAuthCallbackHandler

	async handleOpenRouterCallback(code: string, codeVerifier?: string) {
		return handleOpenRouterOAuth(this, code, codeVerifier)
	}

	async handleRequestyCallback(code: string, baseUrl: string | null) {
		return handleRequestyOAuth(this, code, baseUrl)
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
		await this.webviewRouter.postState()
		// Sync bypass status bar indicator with current permission mode
		const state = await this.getState()
		this.bypassStatusBar.update(computePermissionMode(state))
	}

	/**
	 * Like postStateToWebview but intentionally omits taskHistory.
	 */
	async postStateToWebviewWithoutTaskHistory(): Promise<void> {
		await this.webviewRouter.postStateWithoutTaskHistory()
	}

	/**
	 * Like postStateToWebview but intentionally omits both clineMessages and taskHistory.
	 */
	async postStateToWebviewWithoutClineMessages(): Promise<void> {
		await this.webviewRouter.postStateWithoutClineMessages()
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const providerState = await this.getState()
		const commandLists = getMergedCommandLists(providerState.allowedCommands, providerState.deniedCommands)
		return await buildWebviewState(this, providerState, commandLists)
	}

	/**
	 * Storage
	 * https://dev.to/kompotkot/how-to-use-secretstorage-in-your-vscode-extensions-2hco
	 * https://www.eliostruyf.com/devhack-code-extension-storage-options/
	 */

	async getState(): Promise<ClineProviderState> {
		return getState(this)
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

	public async setValue<K extends keyof NJUST_AISettings>(key: K, value: NJUST_AISettings[K]) {
		await this.settingsManager.setValue(key, value)
	}

	public getValue<K extends keyof NJUST_AISettings>(key: K) {
		return this.settingsManager.getValue(key)
	}

	public getValues() {
		return this.settingsManager.getValues()
	}

	public async setValues(values: NJUST_AISettings) {
		await this.settingsManager.setValues(values)
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
		logger.info("ClineProvider", message)
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

	public getSkillsManager(): ISkillsManager | undefined {
		return this.skillsManager
	}

	/**
	 * Lazily initialise and return the MemRL MemoryManager.
	 * @param cwd - Explicit workspace path (preferred). Falls back to getWorkspacePath().
	 */
	public getMemoryManager(cwd?: string): IMemoryManager | undefined {
		const resolvedCwd = cwd || getWorkspacePath()
		if (!resolvedCwd) return undefined
		// Re-create if the workspace path changed
		if (
			!this._memoryManager ||
			(this._memoryManager as unknown as { workspaceDir: string }).workspaceDir !== resolvedCwd
		) {
			this._memoryManager = this.services.createMemoryManager(resolvedCwd)
		}
		return this._memoryManager
	}

	/**
	 * Gets the CodeIndexManager for the current active workspace
	 * @returns CodeIndexManager instance for the current workspace or the default one
	 */
	public getCurrentWorkspaceCodeIndexManager(): ICodeIndexManager | undefined {
		return this.services.getCodeIndexManager(this.context)
	}

	/**
	 * Gets all active CodeIndexManager instances across workspaces
	 */
	public getAllCodeIndexManagers(): ICodeIndexManager[] {
		return this.services.getAllCodeIndexManagers()
	}

	/**
	 * Gets the Cangjie prompt services
	 */
	public getCangjiePromptServices(): ICangjiePromptServices {
		return this.services.getCangjiePromptServices()
	}

	/**
	 * Gets the ProfileStorageService for Cloud Agent profile management
	 */
	public getProfileStorageService(): IProfileStorageService {
		return this.services.getProfileStorageService()
	}

	/**
	 * Gets NJUST-AI directories for the current workspace
	 */
	public getRooDirectoriesForCwd(cwd: string): string[] {
		return this.services.getRooDirectoriesForCwd(cwd)
	}

	/**
	 * Search workspace files
	 */
	public searchWorkspaceFiles(
		query: string,
		workspacePath: string,
		limit?: number,
	): Promise<{ path: string; type: "file" | "folder"; label?: string }[]> {
		return this.services.searchWorkspaceFiles(query, workspacePath, limit)
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
					void this.postMessageToWebview({
						type: "indexingStatusUpdate",
						values: fullStatus,
					})
				}
			})

			if (this.view) {
				this.webviewDisposables.push(this.codeIndexStatusSubscription)
			}

			// Send initial status for the current workspace
			void this.postMessageToWebview({
				type: "indexingStatusUpdate",
				values: currentManager.getCurrentStatus(),
			})
		}
	}

	/**
	 * TaskProviderLike, TelemetryPropertiesProvider
	 */

	public getCurrentTask(): Task | undefined {
		return this.taskCoordinator?.getCurrentTask() ?? this.taskManagement.getCurrentTask()
	}

	getTaskStackSize(): number {
		return this.taskCoordinator?.getTaskStackSize() ?? this.taskManagement.getTaskStackSize()
	}

	public getCurrentTaskStack(): string[] {
		return this.taskCoordinator?.getCurrentTaskStack() ?? this.taskManagement.getCurrentTaskStack()
	}

	public getRecentTasks(): string[] {
		return this.taskCoordinator?.getRecentTasks() ?? this.taskManagement.getRecentTasks()
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
		configuration: NJUST_AISettings = {},
	): Promise<Task> {
		return this.taskCoordinator.createTask(text, images, parentTask, options, configuration)
	}

	private async createTaskInternal(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: NJUST_AISettings = {},
	): Promise<Task> {
		return this.taskManagement.createTaskInternal(text, images, parentTask, options, configuration)
	}

	public async cancelTask(): Promise<void> {
		await (this.taskCoordinator?.cancelTask() ?? ClineProvider.prototype.cancelTaskInternal.call(this))
	}

	private async cancelTaskInternal(): Promise<void> {
		return this.taskManagement.cancelTaskInternal()
	}

	// Clear the current task without treating it as a subtask.
	// This is used when the user cancels a task that is not a subtask.
	public async clearTask(): Promise<void> {
		await (this.taskCoordinator?.clearTask() ?? ClineProvider.prototype.clearTaskInternal.call(this))
	}

	private async clearTaskInternal(): Promise<void> {
		return this.taskManagement.clearTaskInternal()
	}

	public resumeTask(taskId: string): void {
		if (this.taskCoordinator) {
			this.taskCoordinator.resumeTask(taskId)
			return
		}
		ClineProvider.prototype.resumeTaskInternal.call(this, taskId)
	}

	private resumeTaskInternal(taskId: string): void {
		// Use the existing showTaskWithId method which handles both current and
		// historical tasks.
		this.showTaskWithId(taskId).catch((error) => {
			this.log(`Failed to resume task ${taskId}: ${error.message}`)
		})
	}

	// Modes

	public async getCustomModes() {
		return this.customModesManager.getCustomModes()
	}

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

	public async getTelemetryProperties(): Promise<TelemetryProperties> {
		const state = await this.getState()
		return getTelemetryProperties(this, state)
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
		return delegateParentAndOpenChildWithProvider(this, params)
	}

	/**
	 * Reopen parent task from delegation with write-back and events.
	 */
	public async reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		return reopenParentFromDelegationWithProvider(this, params)
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
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			// Return file URI as fallback
			return vscode.Uri.file(filePath).toString()
		}
	}
}
