/**
 * TaskHistoryService — Task history CRUD, search, export, and globalState sync.
 *
 * Extracted from ClineProvider.ts to decompose the monolithic provider.
 */

import * as path from "path"
import fs from "fs/promises"
import type { Anthropic } from "@anthropic-ai/sdk"
import type * as vscode from "vscode"

import type { HistoryItem, ExtensionMessage } from "@njust-ai-cj/types"

import type { Task } from "../task/Task"
import type { TaskHistoryStore } from "../task-persistence"
import type { TaskStackManager } from "./TaskStackManager"
import { fileExistsAtPath } from "../../utils/fs"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { downloadTask, getTaskFileName } from "../../integrations/misc/export-markdown"
import { resolveDefaultSaveUri, saveLastExportPath } from "../../utils/export"
import { ShadowCheckpointService } from "../../services/checkpoints/ShadowCheckpointService"
import { pruneStaleRegistrations, NO_TASK_KEY } from "../../services/cangjie-lsp/cangjieGeneratedTestCleanup"
import { aggregateTaskCostsRecursive, type AggregatedCosts } from "./aggregateTaskCosts"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

export interface TaskHistoryHost {
	readonly context: vscode.ExtensionContext
	readonly contextProxy: {
		readonly globalStorageUri: vscode.Uri
		getValue<K extends string>(key: K): UnsafeAny
		setValue<K extends string>(key: K, value: UnsafeAny): Promise<void>
	}
	readonly taskHistoryStore: TaskHistoryStore
	readonly outputChannel: vscode.OutputChannel
	readonly cwd: string
	isViewLaunched: boolean
	readonly stack: TaskStackManager
	postMessageToWebview(message: ExtensionMessage): Promise<void>
}

export class TaskHistoryService {
	private static readonly GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS = 5000

	private _initialized = false
	private _recentTasksCache?: string[]
	private _globalStateWriteThroughTimer: ReturnType<typeof setTimeout> | null = null

	constructor(private host: TaskHistoryHost) {}

	get initialized(): boolean {
		return this._initialized
	}

	// ── Initialization ──────────────────────────────────────────────

	async initialize(): Promise<void> {
		try {
			await this.host.taskHistoryStore.initialize()

			const migrationKey = "taskHistoryMigratedToFiles"
			const alreadyMigrated = this.host.context.globalState.get<boolean>(migrationKey)

			if (!alreadyMigrated) {
				const legacyHistory = this.host.context.globalState.get<HistoryItem[]>("taskHistory") ?? []

				if (legacyHistory.length > 0) {
					this.log(`[TaskHistoryService] Migrating ${legacyHistory.length} entries from globalState`)
					await this.host.taskHistoryStore.migrateFromGlobalState(legacyHistory)
				}

				await this.host.context.globalState.update(migrationKey, true)
				this.log("[TaskHistoryService] Migration complete")
			}

			this._initialized = true

			try {
				const { filesRemoved, taskEntriesRemoved } = pruneStaleRegistrations((id) => {
					if (id === NO_TASK_KEY) return false
					const h = this.host.taskHistoryStore.get(id)
					if (!h || h.status === "completed") return false
					return true
				})
				if (filesRemoved > 0) {
					this.host.outputChannel.appendLine(
						`[CangjieTestCleanup] 启动修剪：移除 ${filesRemoved} 个生成测试文件（${taskEntriesRemoved} 个任务桶）。`,
					)
				}
			} catch (e) {
				this.log(`[CangjieTestCleanup] prune failed: ${getErrorMessage(e)}`)
			}

			const items = this.host.taskHistoryStore.getAll().filter((item: HistoryItem) => item.ts && item.task)
			void this.host.postMessageToWebview({ type: "taskHistoryUpdated", taskHistory: items })
		} catch (error) {
			this.log(`[TaskHistoryService] Init error: ${getErrorMessage(error)}`)
		}
	}

	// ── Task Retrieval ──────────────────────────────────────────────

	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const historyItem =
			this.host.taskHistoryStore.get(id) ?? (this.host.context.globalState.get<HistoryItem[]>("taskHistory") ?? []).find((item) => item.id === id)

		if (!historyItem) {
			throw new Error("Task not found")
		}

		const { getTaskDirectoryPath } = await import("../../utils/storage")
		const globalStoragePath = this.host.contextProxy.globalStorageUri.fsPath
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, id)
		const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
		const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
		const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)

		let apiConversationHistory: Anthropic.MessageParam[] = []

		if (fileExists) {
			try {
				apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
			} catch (error) {
				logger.warn(
					"TaskHistoryService",
					`getTaskWithId: api_conversation_history.json corrupted for task ${id}, returning empty history: ${getErrorMessage(error)}`,
				)
				TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			}
		} else {
			logger.warn(
				"TaskHistoryService",
				`getTaskWithId: api_conversation_history.json missing for task ${id}, returning empty history`,
			)
		}

		return {
			historyItem,
			taskDirPath,
			apiConversationHistoryFilePath,
			uiMessagesFilePath,
			apiConversationHistory,
		}
	}

	async getTaskWithAggregatedCosts(taskId: string): Promise<{
		historyItem: HistoryItem
		aggregatedCosts: AggregatedCosts
	}> {
		const { historyItem } = await this.getTaskWithId(taskId)

		const aggregatedCosts = await aggregateTaskCostsRecursive(taskId, async (id: string) => {
			const result = await this.getTaskWithId(id)
			return result.historyItem
		})

		return { historyItem, aggregatedCosts }
	}

	async showTaskWithId(id: string, createTaskWithHistoryItem: (item: HistoryItem) => Promise<void>): Promise<void> {
		const currentTask = this.host.stack.current
		if (id !== currentTask?.taskId) {
			const { historyItem } = await this.getTaskWithId(id)
			await createTaskWithHistoryItem(historyItem)
		}
		void this.host.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
	}

	async exportTaskWithId(id: string): Promise<void> {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		const fileName = getTaskFileName(historyItem.ts)
		const homedir = (await import("os")).homedir()
		const defaultUri = await resolveDefaultSaveUri(this.host.contextProxy as UnsafeAny, "lastTaskExportPath", fileName, {
			useWorkspace: false,
			fallbackDir: path.join(homedir, "Downloads"),
		})
		const saveUri = await downloadTask(historyItem.ts, apiConversationHistory, defaultUri)

		if (saveUri) {
			await saveLastExportPath(this.host.contextProxy as UnsafeAny, "lastTaskExportPath", saveUri)
		}
	}

	async condenseTaskContext(taskId: string): Promise<void> {
		let task: Task | undefined
		const stack = this.host.stack.getStack()
		for (let i = stack.length - 1; i >= 0; i--) {
			if (stack[i]!.taskId === taskId) {
				task = stack[i]
				break
			}
		}
		if (!task) {
			throw new Error(`Task with id ${taskId} not found in stack`)
		}
		await task.condenseContext()
		void this.host.postMessageToWebview({ type: "condenseTaskContextResponse", text: taskId })
	}

	// ── Task Deletion ───────────────────────────────────────────────

	async deleteTaskWithId(id: string, cascadeSubtasks: boolean = true): Promise<void> {
		try {
			const { taskDirPath: _taskDirPath, historyItem: _historyItem } = await this.getTaskWithId(id)

			const allIdsToDelete: string[] = [id]

			if (cascadeSubtasks) {
				const collectChildIds = async (taskId: string): Promise<void> => {
					try {
						const { historyItem: item } = await this.getTaskWithId(taskId)
						if (item.childIds && item.childIds.length > 0) {
							for (const childId of item.childIds) {
								allIdsToDelete.push(childId)
								await collectChildIds(childId)
							}
						}
					} catch (_error) {
						logger.warn("TaskHistoryService", `deleteTaskWithId: child task ${taskId} not found or error during deletion:`, _error)
					}
				}

				await collectChildIds(id)
			}

			for (const taskId of allIdsToDelete) {
				const currentTask = this.host.stack.current
				if (taskId === currentTask?.taskId) {
					await this.host.stack.pop()
					break
				}
			}

			await this.host.taskHistoryStore.deleteMany(allIdsToDelete)
			this._recentTasksCache = undefined

			const globalStorageDir = this.host.contextProxy.globalStorageUri.fsPath
			const workspaceDir = this.host.cwd
			const { getTaskDirectoryPath } = await import("../../utils/storage")
			const globalStoragePath = this.host.contextProxy.globalStorageUri.fsPath

			for (const taskId of allIdsToDelete) {
				try {
					await ShadowCheckpointService.deleteTask({ taskId, globalStorageDir, workspaceDir })
				} catch (error) {
					logger.error(
						"TaskHistoryService",
						`deleteTaskWithId: failed to delete associated shadow repository or branch: ${getErrorMessage(error)}`,
					)
					TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
				}

				try {
					const dirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
					await fs.rm(dirPath, { recursive: true, force: true })
					logger.info("TaskHistoryService", `deleteTaskWithId: removed task directory for ${taskId}`)
				} catch (error) {
					logger.error(
						"TaskHistoryService",
						`deleteTaskWithId: failed to remove task directory: ${getErrorMessage(error)}`,
					)
					TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
				}
			}
		} catch (error) {
			if (error instanceof Error && error.message === "Task not found") {
				await this.deleteTaskFromState(id)
				return
			}
			throw error
		}
	}

	async deleteTaskFromState(id: string): Promise<void> {
		await this.host.taskHistoryStore.delete(id)
		this._recentTasksCache = undefined
	}

	// ── Task History Mutations ──────────────────────────────────────

	async updateTaskHistory(item: HistoryItem, options: { broadcast?: boolean } = {}): Promise<HistoryItem[]> {
		const { broadcast = true } = options

		const history = await this.host.taskHistoryStore.upsert(item)
		this._recentTasksCache = undefined

		if (broadcast && this.host.isViewLaunched) {
			const updatedItem = this.host.taskHistoryStore.get(item.id) ?? item
			await this.host.postMessageToWebview({ type: "taskHistoryItemUpdated", taskHistoryItem: updatedItem })
		}

		return history
	}

	async broadcastTaskHistoryUpdate(history?: HistoryItem[]): Promise<void> {
		if (!this.host.isViewLaunched) {
			return
		}

		const taskHistory = history ?? this.host.taskHistoryStore.getAll()

		const sortedHistory = taskHistory
			.filter((item: HistoryItem) => item.ts && item.task)
			.sort((a: HistoryItem, b: HistoryItem) => b.ts - a.ts)

		await this.host.postMessageToWebview({
			type: "taskHistoryUpdated",
			taskHistory: sortedHistory,
		})
	}

	// ── Recent Tasks ────────────────────────────────────────────────

	getRecentTasks(): string[] {
		if (this._recentTasksCache) {
			return this._recentTasksCache
		}

		const history = this.host.taskHistoryStore.getAll()
		const workspaceTasks: HistoryItem[] = []

		for (const item of history) {
			if (!item.ts || !item.task || item.workspace !== this.host.cwd) {
				continue
			}

			workspaceTasks.push(item)
		}

		if (workspaceTasks.length === 0) {
			this._recentTasksCache = []
			return this._recentTasksCache
		}

		workspaceTasks.sort((a, b) => b.ts - a.ts)
		let recentTaskIds: string[] = []

		if (workspaceTasks.length >= 100) {
			const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000

			for (const item of workspaceTasks) {
				if (item.ts < sevenDaysAgo) {
					break
				}

				recentTaskIds.push(item.id)
			}
		} else {
			recentTaskIds = workspaceTasks.slice(0, Math.min(100, workspaceTasks.length)).map((item) => item.id)
		}

		this._recentTasksCache = recentTaskIds
		return this._recentTasksCache
	}

	// ── GlobalState Write-Through ───────────────────────────────────

	scheduleGlobalStateWriteThrough(): void {
		if (this._globalStateWriteThroughTimer) {
			clearTimeout(this._globalStateWriteThroughTimer)
		}

		this._globalStateWriteThroughTimer = setTimeout(async () => {
			this._globalStateWriteThroughTimer = null
			try {
				const items = this.host.taskHistoryStore.getAll()
				await this.host.contextProxy.setValue("taskHistory", items)
			} catch (err) {
				this.log(
					`[scheduleGlobalStateWriteThrough] Failed: ${getErrorMessage(err)}`,
				)
			}
		}, TaskHistoryService.GLOBAL_STATE_WRITE_THROUGH_DEBOUNCE_MS)
	}

	flushGlobalStateWriteThrough(): void {
		if (this._globalStateWriteThroughTimer) {
			clearTimeout(this._globalStateWriteThroughTimer)
			this._globalStateWriteThroughTimer = null
		}

		const items = this.host.taskHistoryStore.getAll()
		this.host.contextProxy.setValue("taskHistory", items).catch((err: UnsafeAny) => {
			this.log(`[flushGlobalStateWriteThrough] Failed: ${getErrorMessage(err)}`)
		})
	}

	// ── Cleanup ─────────────────────────────────────────────────────

	dispose(): void {
		this.flushGlobalStateWriteThrough()
	}

	// ── Helpers ─────────────────────────────────────────────────────

	private log(message: string): void {
		this.host.outputChannel.appendLine(message)
		logger.info("TaskHistoryService", message)
	}
}
