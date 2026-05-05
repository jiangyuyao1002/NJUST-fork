/**
 * TaskStackManager — Task stack lifecycle management (LIFO ordering).
 *
 * Extracted from ClineProvider.ts to decompose the monolithic provider.
 * Manages the task stack, event listener bindings, and delegation repair.
 */

import type * as vscode from "vscode"

import { NJUST_AI_CJEventName, type HistoryItem, type TokenUsage, type ToolUsage } from "@njust-ai-cj/types"

import type { Task } from "../task/Task"

export interface TaskStackHost {
	readonly outputChannel: vscode.OutputChannel
	emit(event: string | symbol, ...args: any[]): boolean
	getState(): Promise<{ mode: string }>
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	updateTaskHistory(item: HistoryItem, options?: { broadcast?: boolean }): Promise<HistoryItem[]>
	createTaskWithHistoryItem(
		historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
		options?: { startTask?: boolean },
	): Promise<Task>
	performPreparationTasks?(task: Task): Promise<void>
}

export class TaskStackManager {
	private stack: Task[] = []
	private taskEventListeners: WeakMap<Task, Array<() => void>> = new WeakMap()

	constructor(private readonly host: TaskStackHost) {}

	// ── Public Getters ──────────────────────────────────────────────

	/** Current (top) task on the stack, or undefined if empty */
	get current(): Task | undefined {
		if (this.stack.length === 0) {
			return undefined
		}
		return this.stack[this.stack.length - 1]
	}

	/** Root (first) task on the stack, or undefined if empty */
	get root(): Task | undefined {
		return this.stack.length > 0 ? this.stack[0] : undefined
	}

	/** Number of tasks on the stack */
	get size(): number {
		return this.stack.length
	}

	/** All task IDs on the stack (bottom to top) */
	get taskIds(): string[] {
		return this.stack.map((cline) => cline.taskId)
	}

	/** Read-only access to the underlying stack array */
	getStack(): readonly Task[] {
		return this.stack
	}

	// ── Event Binding ──────────────────────────────────────────────

	/**
	 * Bind event forwarders for a task instance.
	 * All forwarded events are emitted on the provider's event bus.
	 */
	bindEventForwarders(instance: Task): void {
		const onTaskStarted = () => this.host.emit(NJUST_AI_CJEventName.TaskStarted, instance.taskId)
		const onTaskCompleted = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) =>
			this.host.emit(NJUST_AI_CJEventName.TaskCompleted, taskId, tokenUsage, toolUsage, {
				isSubtask: false,
			})
		const onTaskAborted = async () => {
			this.host.emit(NJUST_AI_CJEventName.TaskAborted, instance.taskId)
			try {
				if (instance.abortReason === "streaming_failed") {
					const current = this.current
					if (current && current.instanceId !== instance.instanceId) {
						this.log(
							`[onTaskAborted] Skipping rehydrate: current instance ${current.instanceId} != aborted ${instance.instanceId}`,
						)
						return
					}
					const { historyItem } = await this.host.getTaskWithId(instance.taskId)
					await this.host.createTaskWithHistoryItem({
						...historyItem,
						rootTask: instance.rootTask,
						parentTask: instance.parentTask,
					})
				}
			} catch (error) {
				this.log(
					`[onTaskAborted] Failed to rehydrate after streaming failure: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
			}
		}
		const onTaskFocused = () => this.host.emit(NJUST_AI_CJEventName.TaskFocused, instance.taskId)
		const onTaskUnfocused = () => this.host.emit(NJUST_AI_CJEventName.TaskUnfocused, instance.taskId)
		const onTaskActive = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskActive, taskId)
		const onTaskInteractive = (taskId: string) =>
			this.host.emit(NJUST_AI_CJEventName.TaskInteractive, taskId)
		const onTaskResumable = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskResumable, taskId)
		const onTaskIdle = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskIdle, taskId)
		const onTaskPaused = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskPaused, taskId)
		const onTaskUnpaused = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskUnpaused, taskId)
		const onTaskSpawned = (taskId: string) => this.host.emit(NJUST_AI_CJEventName.TaskSpawned, taskId)
		const onTaskUserMessage = (taskId: string) =>
			this.host.emit(NJUST_AI_CJEventName.TaskUserMessage, taskId)
		const onTaskTokenUsageUpdated = (taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage) =>
			this.host.emit(NJUST_AI_CJEventName.TaskTokenUsageUpdated, taskId, tokenUsage, toolUsage)

		instance.on(NJUST_AI_CJEventName.TaskStarted, onTaskStarted)
		instance.on(NJUST_AI_CJEventName.TaskCompleted, onTaskCompleted)
		instance.on(NJUST_AI_CJEventName.TaskAborted, onTaskAborted)
		instance.on(NJUST_AI_CJEventName.TaskFocused, onTaskFocused)
		instance.on(NJUST_AI_CJEventName.TaskUnfocused, onTaskUnfocused)
		instance.on(NJUST_AI_CJEventName.TaskActive, onTaskActive)
		instance.on(NJUST_AI_CJEventName.TaskInteractive, onTaskInteractive)
		instance.on(NJUST_AI_CJEventName.TaskResumable, onTaskResumable)
		instance.on(NJUST_AI_CJEventName.TaskIdle, onTaskIdle)
		instance.on(NJUST_AI_CJEventName.TaskPaused, onTaskPaused)
		instance.on(NJUST_AI_CJEventName.TaskUnpaused, onTaskUnpaused)
		instance.on(NJUST_AI_CJEventName.TaskSpawned, onTaskSpawned)
		instance.on(NJUST_AI_CJEventName.TaskUserMessage, onTaskUserMessage)
		instance.on(NJUST_AI_CJEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated)

		this.taskEventListeners.set(instance, [
			() => instance.off(NJUST_AI_CJEventName.TaskStarted, onTaskStarted),
			() => instance.off(NJUST_AI_CJEventName.TaskCompleted, onTaskCompleted),
			() => instance.off(NJUST_AI_CJEventName.TaskAborted, onTaskAborted),
			() => instance.off(NJUST_AI_CJEventName.TaskFocused, onTaskFocused),
			() => instance.off(NJUST_AI_CJEventName.TaskUnfocused, onTaskUnfocused),
			() => instance.off(NJUST_AI_CJEventName.TaskActive, onTaskActive),
			() => instance.off(NJUST_AI_CJEventName.TaskInteractive, onTaskInteractive),
			() => instance.off(NJUST_AI_CJEventName.TaskResumable, onTaskResumable),
			() => instance.off(NJUST_AI_CJEventName.TaskIdle, onTaskIdle),
			() => instance.off(NJUST_AI_CJEventName.TaskUserMessage, onTaskUserMessage),
			() => instance.off(NJUST_AI_CJEventName.TaskPaused, onTaskPaused),
			() => instance.off(NJUST_AI_CJEventName.TaskUnpaused, onTaskUnpaused),
			() => instance.off(NJUST_AI_CJEventName.TaskSpawned, onTaskSpawned),
			() => instance.off(NJUST_AI_CJEventName.TaskTokenUsageUpdated, onTaskTokenUsageUpdated),
		])
	}

	// ── Stack Operations ──────────────────────────────────────────────

	/**
	 * Add a new task to the top of the stack.
	 * Emits TaskFocused event and runs preparation tasks.
	 */
	async push(task: Task): Promise<void> {
		this.stack.push(task)
		task.emit(NJUST_AI_CJEventName.TaskFocused)

		await this.host.performPreparationTasks?.(task)

		const state = await this.host.getState()
		if (!state || typeof state.mode !== "string") {
			throw new Error("Failed to retrieve current mode")
		}
	}

	/**
	 * Remove and destroy the top task from the stack.
	 * Repairs parent delegation metadata if needed.
	 */
	async pop(options?: { skipDelegationRepair?: boolean }): Promise<void> {
		if (this.stack.length === 0) {
			return
		}

		let task = this.stack.pop()

		if (task) {
			const childTaskId = task.taskId
			const parentTaskId = task.parentTaskId

			task.emit(NJUST_AI_CJEventName.TaskUnfocused)

			try {
				await task.abortTask(true)
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				this.log(`[TaskStackManager#pop] abortTask() failed ${task.taskId}.${task.instanceId}: ${msg}`)
			}

			const cleanupFunctions = this.taskEventListeners.get(task)
			if (cleanupFunctions) {
				cleanupFunctions.forEach((cleanup) => cleanup())
				this.taskEventListeners.delete(task)
			}

			task = undefined

			if (parentTaskId && childTaskId && !options?.skipDelegationRepair) {
				try {
					const { historyItem: parentHistory } = await this.host.getTaskWithId(parentTaskId)

					if (parentHistory.status === "delegated" && parentHistory.awaitingChildId === childTaskId) {
						await this.host.updateTaskHistory({
							...parentHistory,
							status: "active",
							awaitingChildId: undefined,
						})
						this.log(
							`[TaskStackManager#pop] Repaired parent ${parentTaskId} metadata: delegated → active (child ${childTaskId} removed)`,
						)
					}
				} catch (err) {
					this.log(
						`[TaskStackManager#pop] Failed to repair parent metadata for ${parentTaskId} (non-fatal): ${
							err instanceof Error ? err.message : String(err)
						}`,
					)
				}
			}
		}
	}

	/**
	 * Rehydrate the current task in-place without flicker.
	 * Used for checkpoint restoration.
	 */
	async rehydrate(task: Task): Promise<void> {
		const stackIndex = this.stack.length - 1
		const oldTask = this.stack[stackIndex]
		try {
			await oldTask.abortTask(true)
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			this.log(
				`[rehydrate] abortTask() failed for old task ${oldTask.taskId}.${oldTask.instanceId}: ${msg}`,
			)
		}
		const cleanupFunctions = this.taskEventListeners.get(oldTask)
		if (cleanupFunctions) {
			cleanupFunctions.forEach((cleanup) => cleanup())
			this.taskEventListeners.delete(oldTask)
		}
		this.stack[stackIndex] = task
		task.emit(NJUST_AI_CJEventName.TaskFocused)
		await this.host.performPreparationTasks?.(task)
		this.log(`[rehydrate] rehydrated task ${task.taskId}.${task.instanceId} in-place (flicker-free)`)
	}

	// ── Private Helpers ──────────────────────────────────────────────

	private log(message: string): void {
		this.host.outputChannel.appendLine(message)
	}
}
