import { z } from "zod"

import { NJUST_AIEventName } from "./events.js"
import type { NJUST_AISettings } from "./global-settings.js"
import type { ClineMessage, QueuedMessage, TokenUsage } from "./message.js"
import type { ToolUsage, ToolName } from "./tool.js"
import type { TodoItem } from "./todo.js"

/**
 * TaskProviderLike
 */

export interface TaskProviderLike {
	// Tasks
	getCurrentTask(): TaskLike | undefined
	getRecentTasks(): string[]
	createTask(
		text?: string,
		images?: string[],
		parentTask?: TaskLike,
		options?: CreateTaskOptions,
		configuration?: NJUST_AISettings,
	): Promise<TaskLike>
	cancelTask(): Promise<void>
	clearTask(): Promise<void>
	resumeTask(taskId: string): void

	// Modes
	getModes(): Promise<{ slug: string; name: string }[]>
	getMode(): Promise<string>
	setMode(mode: string): Promise<void>

	// Provider Profiles
	getProviderProfiles(): Promise<{ name: string; provider?: string }[]>
	getProviderProfile(): Promise<string>
	setProviderProfile(providerProfile: string): Promise<void>

	readonly cwd: string

	// Event Emitter
	on<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	off<K extends keyof TaskProviderEvents>(
		event: K,
		listener: (...args: TaskProviderEvents[K]) => void | Promise<void>,
	): this

	// @TODO: Find a better way to do this.
	postStateToWebview(): Promise<void>
}

export type TaskProviderEvents = {
	[NJUST_AIEventName.TaskCreated]: [task: TaskLike]
	[NJUST_AIEventName.TaskStarted]: [taskId: string]
	[NJUST_AIEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage, meta: { isSubtask: boolean }]
	[NJUST_AIEventName.TaskAborted]: [taskId: string]
	[NJUST_AIEventName.TaskFocused]: [taskId: string]
	[NJUST_AIEventName.TaskUnfocused]: [taskId: string]
	[NJUST_AIEventName.TaskActive]: [taskId: string]
	[NJUST_AIEventName.TaskInteractive]: [taskId: string]
	[NJUST_AIEventName.TaskResumable]: [taskId: string]
	[NJUST_AIEventName.TaskIdle]: [taskId: string]

	[NJUST_AIEventName.TaskPaused]: [taskId: string]
	[NJUST_AIEventName.TaskUnpaused]: [taskId: string]
	[NJUST_AIEventName.TaskSpawned]: [taskId: string]
	[NJUST_AIEventName.TaskDelegated]: [parentTaskId: string, childTaskId: string]
	[NJUST_AIEventName.TaskDelegationCompleted]: [parentTaskId: string, childTaskId: string, summary: string]
	[NJUST_AIEventName.TaskDelegationResumed]: [parentTaskId: string, childTaskId: string]

	[NJUST_AIEventName.TaskUserMessage]: [taskId: string]

	[NJUST_AIEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]

	[NJUST_AIEventName.ModeChanged]: [mode: string]
	[NJUST_AIEventName.ProviderProfileChanged]: [config: { name: string; provider?: string }]
}

/**
 * TaskLike
 */

export interface CreateTaskOptions {
	taskId?: string
	enableCheckpoints?: boolean
	consecutiveMistakeLimit?: number
	experiments?: Record<string, boolean>
	initialTodos?: TodoItem[]
	/** Capability-scoped tool whitelist for this task (used for delegated child tasks). */
	allowedTools?: string[]
	/** Optional trace id used to stitch parent/child task observability spans. */
	parentTraceId?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed"
	/** Whether to start the task loop immediately (default: true).
	 *  When false, the caller must invoke `task.start()` manually. */
	startTask?: boolean
}

export enum TaskStatus {
	Running = "running",
	Interactive = "interactive",
	Resumable = "resumable",
	Idle = "idle",
	None = "none",
}

export const taskMetadataSchema = z.object({
	task: z.string().optional(),
	images: z.array(z.string()).optional(),
})

export type TaskMetadata = z.infer<typeof taskMetadataSchema>

export interface TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly childTaskId?: string
	readonly metadata: TaskMetadata
	readonly taskStatus: TaskStatus
	readonly taskAsk: ClineMessage | undefined
	readonly queuedMessages: QueuedMessage[]
	readonly tokenUsage: TokenUsage | undefined

	on<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this
	off<K extends keyof TaskEvents>(event: K, listener: (...args: TaskEvents[K]) => void | Promise<void>): this

	approveAsk(options?: { text?: string; images?: string[] }): void
	denyAsk(options?: { text?: string; images?: string[] }): void
	submitUserMessage(text: string, images?: string[], mode?: string, providerProfile?: string): Promise<void>
	abortTask(): void
}

export type TaskEvents = {
	// Task Lifecycle
	[NJUST_AIEventName.TaskStarted]: []
	[NJUST_AIEventName.TaskCompleted]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage, meta: { isSubtask: boolean }]
	[NJUST_AIEventName.TaskAborted]: []
	[NJUST_AIEventName.TaskFocused]: []
	[NJUST_AIEventName.TaskUnfocused]: []
	[NJUST_AIEventName.TaskActive]: [taskId: string]
	[NJUST_AIEventName.TaskInteractive]: [taskId: string]
	[NJUST_AIEventName.TaskResumable]: [taskId: string]
	[NJUST_AIEventName.TaskIdle]: [taskId: string]

	// Subtask Lifecycle
	[NJUST_AIEventName.TaskPaused]: [taskId: string]
	[NJUST_AIEventName.TaskUnpaused]: [taskId: string]
	[NJUST_AIEventName.TaskSpawned]: [taskId: string]

	// Task Execution
	[NJUST_AIEventName.Message]: [{ action: "created" | "updated"; message: ClineMessage }]
	[NJUST_AIEventName.TaskModeSwitched]: [taskId: string, mode: string]
	[NJUST_AIEventName.TaskAskResponded]: []
	[NJUST_AIEventName.TaskUserMessage]: [taskId: string]
	[NJUST_AIEventName.QueuedMessagesUpdated]: [taskId: string, messages: QueuedMessage[]]

	// Task Analytics
	[NJUST_AIEventName.TaskToolFailed]: [taskId: string, tool: ToolName, error: string]
	[NJUST_AIEventName.TaskTokenUsageUpdated]: [taskId: string, tokenUsage: TokenUsage, toolUsage: ToolUsage]
}
