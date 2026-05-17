import * as vscode from "vscode"
import type { ClineProvider } from "../core/webview/ClineProvider"
import type { ClineMessage } from "@njust-ai-cj/types"

interface SyncedTask {
	taskId: string
	source: "chat" | "webview"
	chatStream?: vscode.ChatResponseStream
	lastSyncedIndex: number
}

/**
 * ChatStateSync synchronizes task state between the VSCode Chat Panel
 * and the Webview sidebar. Tasks created in either UI are visible in both,
 * with progress updates streamed to the Chat Panel.
 */
export class ChatStateSync {
	private syncedTasks: Map<string, SyncedTask> = new Map()
	private pollIntervals: Map<string, ReturnType<typeof setInterval>> = new Map()

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
			lastSyncedIndex: 0,
		})

		this.startPolling(taskId)
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
			lastSyncedIndex: 0,
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
			this.startPolling(taskId)
		}
	}

	/**
	 * Forward a ClineMessage to the chat stream if one is attached.
	 */
	syncMessage(taskId: string, message: ClineMessage): void {
		const synced = this.syncedTasks.get(taskId)
		if (!synced?.chatStream) return

		try {
			this.renderToChatStream(synced.chatStream, message)
		} catch {
			// Stream may have been disposed
		}
	}

	private startPolling(taskId: string): void {
		if (this.pollIntervals.has(taskId)) return

		const interval = setInterval(() => {
			const synced = this.syncedTasks.get(taskId)
			if (!synced?.chatStream) {
				this.stopPolling(taskId)
				return
			}

			try {
				const currentTask = (this.provider as Record<string, UnsafeAny>).getCurrentTask?.()
				if (!currentTask || currentTask.taskId !== taskId) return

				const messages: ClineMessage[] = currentTask.clineMessages || []
				for (let i = synced.lastSyncedIndex; i < messages.length; i++) {
					this.renderToChatStream(synced.chatStream, messages[i]!)
				}
				synced.lastSyncedIndex = messages.length

				if (currentTask.didFinishAbortingStream || currentTask.abandoned) {
					this.stopPolling(taskId)
				}
			} catch {
				this.stopPolling(taskId)
			}
		}, 300)

		this.pollIntervals.set(taskId, interval)
	}

	private stopPolling(taskId: string): void {
		const interval = this.pollIntervals.get(taskId)
		if (interval) {
			clearInterval(interval)
			this.pollIntervals.delete(taskId)
		}
	}

	private renderToChatStream(stream: vscode.ChatResponseStream, msg: ClineMessage): void {
		if (msg.type === "say") {
			switch (msg.say) {
				case "text":
					if (msg.text) stream.markdown(msg.text)
					break
				case "tool":
					if (msg.text) {
						try {
							const data = JSON.parse(msg.text)
							stream.progress(`Tool: ${data.tool || "executing"}`)
						} catch {
							stream.progress("Executing tool...")
						}
					}
					break
				case "completion_result":
					if (msg.text) stream.markdown(`\n---\n**Result:** ${msg.text}`)
					break
				case "error":
					if (msg.text) stream.markdown(`\n**Error:** ${msg.text}`)
					break
			}
		}
	}

	unregisterTask(taskId: string): void {
		this.stopPolling(taskId)
		this.syncedTasks.delete(taskId)
	}

	dispose(): void {
		for (const [taskId] of this.pollIntervals) {
			this.stopPolling(taskId)
		}
		this.syncedTasks.clear()
	}
}
