import * as vscode from "vscode"
import type { ClineProvider } from "../core/webview/ClineProvider"
import type { ClineMessage } from "@njust-ai/types"
import { NJUST_AIEventName } from "@njust-ai/types"
import type { Task } from "../core/task/Task"
import { renderClineMessage } from "./message-renderer"
import { logger } from "../shared/logger"

interface SyncedTask {
	taskId: string
	source: "chat" | "webview"
	chatStream?: vscode.ChatResponseStream
}

/**
 * ChatStateSync synchronizes task state between the VSCode Chat Panel
 * and the Webview sidebar. Tasks created in either UI are visible in both,
 * with progress updates streamed to the Chat Panel.
 */
export class ChatStateSync {
	private syncedTasks: Map<string, SyncedTask> = new Map()
	private taskCleanupFns: Map<string, () => void> = new Map()

	constructor(
		private readonly provider: ClineProvider,
		private readonly outputChannel: vscode.OutputChannel,
	) {}

	/**
	 * Register a task created from the Chat Panel so its progress
	 * can be synced back to the chat stream.
	 */
	registerChatTask(taskId: string, stream: vscode.ChatResponseStream): void {
		this.syncedTasks.set(taskId, {
			taskId,
			source: "chat",
			chatStream: stream,
		})

		this.subscribeToTask(taskId)
		this.outputChannel.appendLine(`[ChatStateSync] Registered chat task: ${taskId}`)
	}

	/**
	 * Register a task created from the Webview so it can be
	 * tracked across both interfaces.
	 */
	registerWebviewTask(taskId: string): void {
		this.syncedTasks.set(taskId, {
			taskId,
			source: "webview",
		})

		this.outputChannel.appendLine(`[ChatStateSync] Registered webview task: ${taskId}`)
	}

	/**
	 * Attach a chat stream to an existing webview task, enabling
	 * "view in Chat" functionality.
	 */
	attachChatStream(taskId: string, stream: vscode.ChatResponseStream): void {
		const synced = this.syncedTasks.get(taskId)
		if (synced) {
			synced.chatStream = stream
			this.subscribeToTask(taskId)
		}
	}

	/**
	 * Forward a ClineMessage to the chat stream if one is attached.
	 */
	syncMessage(taskId: string, message: ClineMessage): void {
		const synced = this.syncedTasks.get(taskId)
		if (!synced?.chatStream) return

		try {
			renderClineMessage(synced.chatStream, message)
		} catch (err) {
			// Stream may have been disposed — warn but don't disrupt flow
			logger.warn("ChatStateSync", `Failed to sync message for task ${taskId}:`, err)
		}
	}

	private subscribeToTask(taskId: string, retryCount = 0): void {
		if (this.taskCleanupFns.has(taskId)) return

		const currentTask = this.provider.getCurrentTask() as Task | undefined
		if (!currentTask || currentTask.taskId !== taskId) {
			// Task not yet available — retry with exponential backoff up to 5 times
			if (retryCount < 5 && this.syncedTasks.has(taskId)) {
				const delay = 200 * Math.pow(2, retryCount)
				logger.warn(
					"ChatStateSync",
					`Task ${taskId} not ready. Retrying in ${delay}ms... (${retryCount + 1}/5)`,
				)
				const retryTimer = setTimeout(() => {
					this.taskCleanupFns.delete(taskId)
					this.subscribeToTask(taskId, retryCount + 1)
				}, delay)
				this.taskCleanupFns.set(taskId, () => clearTimeout(retryTimer))
			} else if (retryCount >= 5) {
				logger.warn(
					"ChatStateSync",
					`Failed to subscribe to task ${taskId} after 5 retries. Current task ID: ${currentTask?.taskId || "none"}`,
				)
			}
			return
		}

		const synced = this.syncedTasks.get(taskId)
		if (!synced?.chatStream) return

		const onMessage = (data: { action: "created" | "updated"; message: ClineMessage }) => {
			if (data?.action !== "created") return
			const s = this.syncedTasks.get(taskId)
			if (!s?.chatStream) return

			try {
				renderClineMessage(s.chatStream, data.message)
			} catch (err) {
				logger.warn("ChatStateSync", `Failed to render message for task ${taskId}:`, err)
			}
		}

		const onComplete = () => {
			this.unsubscribeFromTask(taskId)
		}

		const onAbort = () => {
			this.unsubscribeFromTask(taskId)
		}

		currentTask.on(NJUST_AIEventName.Message, onMessage)
		currentTask.on(NJUST_AIEventName.TaskCompleted, onComplete)
		currentTask.on(NJUST_AIEventName.TaskAborted, onAbort)

		// Safety timer: catches didFinishAbortingStream / abandoned states
		// that may not emit a corresponding event. Only checks flags, never polls messages.
		const safetyTimer = setInterval(() => {
			if (currentTask.didFinishAbortingStream || currentTask.abandoned || currentTask.taskCompleted) {
				this.unsubscribeFromTask(taskId)
			}
		}, 3000)

		this.taskCleanupFns.set(taskId, () => {
			clearInterval(safetyTimer)
			currentTask.off(NJUST_AIEventName.Message, onMessage)
			currentTask.off(NJUST_AIEventName.TaskCompleted, onComplete)
			currentTask.off(NJUST_AIEventName.TaskAborted, onAbort)
		})
	}

	private unsubscribeFromTask(taskId: string): void {
		const cleanup = this.taskCleanupFns.get(taskId)
		if (cleanup) {
			cleanup()
			this.taskCleanupFns.delete(taskId)
		}
	}

	unregisterTask(taskId: string): void {
		this.unsubscribeFromTask(taskId)
		this.syncedTasks.delete(taskId)
	}

	dispose(): void {
		for (const [taskId] of this.taskCleanupFns) {
			this.unsubscribeFromTask(taskId)
		}
		this.syncedTasks.clear()
	}
}
