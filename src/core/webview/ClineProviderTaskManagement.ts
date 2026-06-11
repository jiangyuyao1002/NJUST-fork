/**
 * ClineProviderTaskManagement — Task stack lifecycle management.
 *
 * Extracted from ClineProvider.ts to decompose the monolithic provider.
 * Manages task creation, cancellation, clearing, and history restoration.
 */

import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { type HistoryItem, type CreateTaskOptions, type NJUST_AISettings, TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import { Package } from "../../shared/package"
import { ProfileValidator } from "../../shared/ProfileValidator"
import { OrganizationAllowListViolationError } from "../../utils/errors"
import { logger } from "../../shared/logger"
import { t } from "../../i18n"

import { Task } from "../task/Task"
import type { TaskStackManager } from "./TaskStackManager"
import type { PendingEditManager } from "./PendingEditManager"
import { restoreHistoryModeAndProfileWithProvider } from "./ClineProviderModeSync"
import type { ClineProvider } from "./ClineProvider"

export interface ClineProviderTaskManagementHost {
	readonly stack: TaskStackManager
	readonly taskHistory: { getRecentTasks(): string[] }
	readonly pendingEditManager: PendingEditManager
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly customModesManager: { updateCustomMode(slug: string, mode: any): Promise<void> }
	readonly taskCreationCallback: (task: Task) => void
	readonly provider: ClineProvider

	getState(): Promise<{
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		apiConfiguration: any
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		organizationAllowList: any
		enableCheckpoints: boolean
		checkpointTimeout: number
		experiments: Record<string, boolean>
	}>

	setValues(configuration: NJUST_AISettings): Promise<void>
	setProviderProfile(name: string): Promise<void>
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	log(message: string): void
}

export class ClineProviderTaskManagement {
	constructor(private readonly host: ClineProviderTaskManagementHost) {}

	public getCurrentTask(): Task | undefined {
		return this.host.stack.current
	}

	public getTaskStackSize(): number {
		return this.host.stack.size
	}

	public getCurrentTaskStack(): string[] {
		return this.host.stack.taskIds
	}

	public getRecentTasks(): string[] {
		return this.host.taskHistory.getRecentTasks()
	}

	public async createTaskInternal(
		text?: string,
		images?: string[],
		parentTask?: Task,
		options: CreateTaskOptions = {},
		configuration: NJUST_AISettings = {},
	): Promise<Task> {
		if (configuration) {
			await this.host.setValues(configuration)

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
				await this.host.setProviderProfile(configuration.currentApiConfigName)
			}

			if (configuration.customModes?.length) {
				for (const mode of configuration.customModes) {
					await this.host.customModesManager.updateCustomMode(mode.slug, mode)
				}
			}
		}

		const { apiConfiguration, organizationAllowList, enableCheckpoints, checkpointTimeout, experiments } =
			await this.host.getState()

		if (!parentTask) {
			try {
				await this.host.stack.pop()
			} catch (error) {
				logger.warn("ClineProviderTaskManagement", "Stack pop failed", error)
				TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			}
		}

		if (!ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList)) {
			throw new OrganizationAllowListViolationError(t("common:errors.violated_organization_allowlist"))
		}

		const task = new Task({
			host: this.host.provider,
			apiConfiguration,
			enableCheckpoints,
			checkpointTimeout,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			task: text,
			images,
			experiments,
			rootTask: this.host.stack.root,
			parentTask,
			taskNumber: this.host.stack.size + 1,
			onCreated: this.host.taskCreationCallback,
			initialTodos: options.initialTodos,
			startTask: false,
			...options,
		})

		await this.host.stack.push(task)
		task.start()

		this.host.log(
			`[createTask] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
		)

		return task
	}

	public async cancelTaskInternal(): Promise<void> {
		const task = this.getCurrentTask()

		if (!task) {
			return
		}

		logger.info("ClineProviderTaskManagement", `cancelTask: cancelling task ${task.taskId}.${task.instanceId}`)

		let historyItem: HistoryItem | undefined
		try {
			const history = await this.host.getTaskWithId(task.taskId)
			historyItem = history.historyItem
		} catch (error) {
			if (error instanceof Error && error.message === "Task not found") {
				this.host.log(`[cancelTask] task history missing for ${task.taskId}; skipping rehydrate`)
			} else {
				throw error
			}
		}

		const rootTask = task.rootTask
		const parentTask = task.parentTask

		task.abortReason = "user_cancelled"

		const originalInstanceId = task.instanceId

		task.cancelCurrentRequest()

		void task.abortTask()

		task.abandoned = true

		await pWaitFor(
			() => {
				const currentTask = this.getCurrentTask()
				return (
					currentTask === undefined ||
					currentTask.isStreaming === false ||
					currentTask.didFinishAbortingStream ||
					currentTask.isWaitingForFirstChunk
				)
			},
			{
				timeout: 3_000,
			},
		).catch(() => {
			logger.error("ClineProviderTaskManagement", "cancelTask: Failed to abort task")
			TelemetryService.reportError(
				new Error("cancelTask: Failed to abort task"),
				TelemetryEventName.WEBVIEW_ERROR,
			)
		})

		const current = this.getCurrentTask()
		if (current && current.instanceId !== originalInstanceId) {
			this.host.log(
				`[cancelTask] Skipping rehydrate: current instance ${current.instanceId} != original ${originalInstanceId}`,
			)
			return
		}

		{
			const currentAfterCheck = this.getCurrentTask()
			if (currentAfterCheck && currentAfterCheck.instanceId !== originalInstanceId) {
				this.host.log(
					`[cancelTask] Skipping rehydrate after final check: current instance ${currentAfterCheck.instanceId} != original ${originalInstanceId}`,
				)
				return
			}
		}

		if (!historyItem) {
			return
		}

		await this.createTaskWithHistoryItem({ ...historyItem, rootTask, parentTask })
	}

	public async clearTaskInternal(): Promise<void> {
		if (this.host.stack.size > 0) {
			const task = this.host.stack.current
			logger.info("ClineProviderTaskManagement", `clearTask: clearing task ${task?.taskId}.${task?.instanceId}`)
			await this.host.stack.pop()
		}
	}

	public async createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	) {
		const isCliRuntime = process.env.NJUST_AI_CLI_RUNTIME === "1"
		const skipProfileRestoreFromHistory = isCliRuntime
		const isRehydratingCurrentTask = this.getCurrentTask()?.taskId === historyItem.id

		if (!isRehydratingCurrentTask) {
			await this.host.stack.pop()
		}

		await restoreHistoryModeAndProfileWithProvider(this.host.provider, historyItem, skipProfileRestoreFromHistory)

		const task = await this.createTaskInstanceFromHistory(historyItem, options)

		if (isRehydratingCurrentTask) {
			await this.host.stack.rehydrate(task)
		} else {
			await this.host.stack.push(task)
			this.host.log(
				`[createTaskWithHistoryItem] ${task.parentTask ? "child" : "parent"} task ${task.taskId}.${task.instanceId} instantiated`,
			)
		}

		await this.applyPendingEditIfPresent(task)
		return task
	}

	private async createTaskInstanceFromHistory(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	): Promise<Task> {
		const { apiConfiguration, enableCheckpoints, checkpointTimeout, experiments } = await this.host.getState()
		return new Task({
			host: this.host.provider,
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
			onCreated: this.host.taskCreationCallback,
			startTask: options?.startTask ?? true,
			initialStatus: historyItem.status,
		})
	}

	private applyPendingEditIfPresent(task: Task): void {
		const operationId = `task-${task.taskId}`
		const pendingEdit = this.host.pendingEditManager.get(operationId)
		if (!pendingEdit) {
			return
		}

		this.host.pendingEditManager.clear(operationId)
		this.host.log(`[createTaskWithHistoryItem] Processing pending edit after checkpoint restoration`)
		setTimeout(async () => {
			try {
				const { messageIndex, apiConversationHistoryIndex } = (() => {
					const messageIndex = task.clineMessages.findIndex((msg) => msg.ts === pendingEdit.messageTs)
					const apiConversationHistoryIndex = task.apiConversationHistory.findIndex(
						(msg) => msg.ts === pendingEdit.messageTs,
					)
					return { messageIndex, apiConversationHistoryIndex }
				})()
				if (messageIndex !== -1) {
					await task.overwriteClineMessages(task.clineMessages.slice(0, messageIndex))
					if (apiConversationHistoryIndex !== -1) {
						await task.overwriteApiConversationHistory(
							task.apiConversationHistory.slice(0, apiConversationHistoryIndex),
						)
					}
					await task.handleWebviewAskResponse(
						"messageResponse",
						pendingEdit.editedContent,
						pendingEdit.images,
					)
				}
			} catch (error) {
				this.host.log(`[createTaskWithHistoryItem] Error processing pending edit: ${error}`)
			}
		}, 100)
	}
}
