import * as vscode from "vscode"

import type { ClineProvider } from "../core/webview/ClineProvider"
import { renderClineMessage } from "./message-renderer"
import { TelemetryEventName, NJUST_AIEventName, type ClineMessage } from "@njust-ai/types"
import type { Task } from "../core/task/Task"
import { TelemetryService } from "@njust-ai/telemetry"
import { getErrorMessage } from "../shared/error-utils"
import { logger } from "../shared/logger"

const PARTICIPANT_ID = "njust-ai.agent"

const COMMAND_MODE_MAP: Record<string, string> = {
	code: "code",
	architect: "architect",
	ask: "ask",
	debug: "debug",
	plan: "orchestrator",
	cangjie: "cangjie",
}

interface RooChatResult extends vscode.ChatResult {
	metadata: {
		command: string
		taskId?: string
	}
}

/**
 * Bridges VSCode's Chat Participant API with the existing ClineProvider/Task system.
 * Users can invoke @njust-ai in the native VSCode chat panel to leverage the full
 * Agent capabilities (file editing, terminal execution, code search, etc.).
 */
export class ChatParticipantHandler {
	private participant: vscode.ChatParticipant
	private activeStreams: Map<string, vscode.ChatResponseStream> = new Map()

	constructor(
		private readonly provider: ClineProvider,
		private readonly context: vscode.ExtensionContext,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, this.handleRequest.bind(this))
		this.participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "icon.png")
		this.participant.followupProvider = {
			provideFollowups: this.provideFollowups.bind(this),
		}

		context.subscriptions.push(this.participant)
		context.subscriptions.push(
			this.participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
				this.outputChannel.appendLine(
					`[ChatParticipant] Feedback received: ${feedback.kind === vscode.ChatResultFeedbackKind.Helpful ? "helpful" : "unhelpful"}`,
				)
			}),
		)
	}

	private async handleRequest(
		request: vscode.ChatRequest,
		chatContext: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<RooChatResult> {
		const command = request.command || "code"
		const modeSlug = COMMAND_MODE_MAP[command] || "code"

		stream.progress(`Starting Njust-AI Agent in ${modeSlug} mode...`)

		try {
			const previousMessages = this.buildContextFromHistory(chatContext)
			const fullPrompt = previousMessages ? `${previousMessages}\n\nUser: ${request.prompt}` : request.prompt

			await this.provider.handleModeSwitch(modeSlug as UnsafeAny)

			const task = await this.provider.createTask(fullPrompt)
			const taskId = task.taskId

			this.activeStreams.set(taskId, stream)

			await this.streamTaskOutput(task, stream, token)

			this.activeStreams.delete(taskId)

			return {
				metadata: {
					command,
					taskId,
				},
			}
		} catch (error) {
			const message = getErrorMessage(error)
			stream.markdown(`**Error:** ${message}`)
			this.outputChannel.appendLine(`[ChatParticipant] Error: ${message}`)
			TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
			return { metadata: { command } }
		}
	}

	private async streamTaskOutput(
		task: Task,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			let resolved = false
			const renderedMessageIds = new Set<string>()
			const getRenderKey = (message: ClineMessage) => message.id || `ts:${message.ts}`

			const onMessage = (data: { action: "created" | "updated"; message: ClineMessage }) => {
				if (resolved || data.action !== "created") return
				const renderKey = getRenderKey(data.message)
				if (renderedMessageIds.has(renderKey)) return
				renderedMessageIds.add(renderKey)
				try {
					renderClineMessage(stream, data.message)
				} catch (err) {
					logger.error("ChatParticipantHandler", "Error rendering message:", err)
					TelemetryService.reportError(err, TelemetryEventName.TASK_LIFECYCLE_ERROR)
				}
			}

			const onComplete = () => {
				cleanup()
				resolve()
			}

			const onAbort = () => {
				cleanup()
				resolve()
			}

			// Safety timer: catches didFinishAbortingStream / abandoned states
			// that may not emit a corresponding event.
			const safetyTimer = setInterval(() => {
				if (task.didFinishAbortingStream || task.abandoned) {
					cleanup()
					resolve()
				}
			}, 3000)

			const cleanup = () => {
				if (resolved) return
				resolved = true
				clearInterval(safetyTimer)
				// Remove all event listeners to prevent leaks
				task.off(NJUST_AIEventName.Message, onMessage)
				task.off(NJUST_AIEventName.TaskCompleted, onComplete)
				task.off(NJUST_AIEventName.TaskAborted, onAbort)
			}

			token.onCancellationRequested(() => {
				void task.abortTask()
				cleanup()
				resolve()
			})

			task.on(NJUST_AIEventName.Message, onMessage)
			task.on(NJUST_AIEventName.TaskCompleted, onComplete)
			task.on(NJUST_AIEventName.TaskAborted, onAbort)

			// Replay messages emitted during task.start() before subscription
			for (const existingMsg of task.clineMessages || []) {
				if (resolved) break
				const renderKey = getRenderKey(existingMsg)
				if (renderedMessageIds.has(renderKey)) continue
				renderedMessageIds.add(renderKey)
				try {
					renderClineMessage(stream, existingMsg)
				} catch (err) {
					logger.error("ChatParticipantHandler", "Error replaying message:", err)
				}
			}

			// Timeout fallback
			setTimeout(
				() => {
					if (!resolved) {
						cleanup()
						resolve()
					}
				},
				5 * 60 * 1000,
			)
		})
	}

	private buildContextFromHistory(chatContext: vscode.ChatContext): string | undefined {
		const relevantHistory = chatContext.history.filter(
			(h) => h instanceof vscode.ChatRequestTurn || h instanceof vscode.ChatResponseTurn,
		)

		if (relevantHistory.length === 0) {
			return undefined
		}

		const parts: string[] = []
		for (const turn of relevantHistory) {
			if (turn instanceof vscode.ChatRequestTurn) {
				parts.push(`User: ${turn.prompt}`)
			} else if (turn instanceof vscode.ChatResponseTurn) {
				const text = turn.response
					.filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
					.map((r) => r.value.value)
					.join("")
				if (text) {
					parts.push(`Assistant: ${text}`)
				}
			}
		}

		return parts.join("\n")
	}

	private provideFollowups(
		result: RooChatResult,
		_context: vscode.ChatContext,
		_token: vscode.CancellationToken,
	): vscode.ChatFollowup[] {
		const followups: vscode.ChatFollowup[] = []

		if (result.metadata.command === "architect") {
			followups.push({
				prompt: "Now implement the plan",
				label: "Implement the plan",
				command: "code",
			})
		} else if (result.metadata.command === "code") {
			followups.push({
				prompt: "Explain what was changed",
				label: "Explain changes",
				command: "ask",
			})
			followups.push({
				prompt: "Debug and fix any issues",
				label: "Debug issues",
				command: "debug",
			})
		} else if (result.metadata.command === "ask") {
			followups.push({
				prompt: "Write code based on this explanation",
				label: "Write code",
				command: "code",
			})
		}

		return followups
	}

	public getActiveStream(taskId: string): vscode.ChatResponseStream | undefined {
		return this.activeStreams.get(taskId)
	}

	dispose(): void {
		this.activeStreams.clear()
	}
}
