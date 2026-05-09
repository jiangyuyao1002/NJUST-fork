/**
 * TaskLifecycleHandler — Owns task start, resume, abort, and dispose logic.
 *
 * Extracted from Task.ts to decompose the monolithic file.
 * Task.ts retains same-signature public facades that delegate to this module.
 *
 * The handler receives the owning Task instance (typed as `TaskLifecycleHost`)
 * and accesses state / methods through that reference. This avoids circular
 * class imports — only the host *interface* is imported here.
 */
import * as path from "path"
import { promises as fs } from "fs"
import type { Anthropic } from "@anthropic-ai/sdk"

import type {
	ClineAsk,
	ClineApiReqInfo,
	ClineMessage,
} from "@njust-ai-cj/types"
import {
	NJUST_AI_CJEventName,
	MAX_MCP_TOOLS_THRESHOLD,
} from "@njust-ai-cj/types"

import { findLastIndex } from "../../shared/array"
import { DEFAULT_MODE_SLUG } from "../../shared/mode-constants"
import { formatResponse } from "../prompts/responses"
import type { ApiMessage } from "../task-persistence"
import { getTaskDirectoryPath } from "../../utils/storage"
import { globalCacheMetrics } from "../../utils/cacheMetrics"
import { globalPromptCacheBreakDetector } from "../prompts/promptCacheBreakDetection"
import { clearMcpInstructionsDelta } from "../prompts/sections/mcp-instructions-delta"
import { deleteGeneratedCangjieTestFilesForTask } from "../../services/cangjie-lsp/cangjieGeneratedTestCleanup"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"
import { safeDispose } from "./TaskLifecycle"
import { logger } from "../../shared/logger"
import { isToolUseBlock } from "../assistant-message/types"

// ── Host type ────────────────────────────────────────────────────────────
// Structural contract: Task implements this shape at runtime.
// This avoids a hard import of Task (breaks the circular dependency risk).

export interface TaskLifecycleHost {
	readonly taskId: string
	readonly instanceId: string
	readonly globalStoragePath: string
	readonly hostRef: WeakRef<{ off(event: string, listener: () => void): void }>
	readonly errorRecovery: { resetCompactFailure(): void }
	readonly messageQueueService: {
		removeListener(event: string, handler: () => void): void
		dispose(): void
	}
	readonly toolExecution: { dispose(): void }
	readonly fileContextTracker: { dispose(): void }
	readonly diffViewProvider: {
		readonly isEditing: boolean
		revertChanges(): Promise<void>
	}

	abort: boolean
	abandoned: boolean
	abortReason?: string
	isInitialized: boolean
	isDisposed: boolean
	isStreaming: boolean
	consecutiveNoToolUseCount: number
	consecutiveNoAssistantMessagesCount: number
	persistentRetryHandler?: { cancel(): void } | undefined
	providerProfileChangeListener?: (() => void) | undefined
	messageQueueStateChangedHandler?: (() => void) | undefined
	rooIgnoreController?: { dispose(): void } | undefined
	clineMessages: ClineMessage[]
	apiConversationHistory: ApiMessage[]

	refreshWebviewState(): Promise<void>
	say(type: any, text?: string, images?: string[], partial?: boolean, checkpoint?: any, progressStatus?: any, options?: any): Promise<undefined>
	ask(type: any, text?: string, partial?: boolean): Promise<{ response: string; text?: string; images?: string[] }>
	emit(event: string, ...args: any[]): boolean
	getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }>
	getTaskMode(): Promise<string>
	initiateCloudAgentLoop(message: string, images?: string[]): Promise<void>
	initiateTaskLoop(userContent: any[]): Promise<void>
	getSavedClineMessages(): Promise<ClineMessage[]>
	getSavedApiConversationHistory(): Promise<ApiMessage[]>
	overwriteClineMessages(messages: ClineMessage[]): Promise<void>
	overwriteApiConversationHistory(history: ApiMessage[]): Promise<void>
	saveClineMessages(): Promise<boolean>
	emitFinalTokenUsageUpdate(): void
	dispose(): void
	cancelCurrentRequest(): void
	removeAllListeners(): void
}

// ── Handler ──────────────────────────────────────────────────────────────

export class TaskLifecycleHandler {
	constructor(private host: TaskLifecycleHost) {}

	// ── startTask ────────────────────────────────────────────────────────

	async startTask(task?: string, images?: string[]): Promise<void> {
		const t = this.host
		try {
			t.clineMessages = []
			t.apiConversationHistory = []

			await t.refreshWebviewState()

			await t.say("text", task, images)

			const { enabledToolCount, enabledServerCount } = await t.getEnabledMcpToolsCount()
			if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
				await t.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold: MAX_MCP_TOOLS_THRESHOLD,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			t.isInitialized = true

			const mode = await t.getTaskMode()

			if (mode === DEFAULT_MODE_SLUG) {
				await t.initiateCloudAgentLoop(task ?? "", images).catch((error: any) => {
					if (t.abandoned === true || t.abortReason === "user_cancelled") {
						return
					}
					throw error
				})
			} else {
				const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

				await t.initiateTaskLoop([
					{
						type: "text",
						text: `<user_message>\n${task}\n</user_message>`,
					},
					...imageBlocks,
				]).catch((error: any) => {
					if (t.abandoned === true || t.abortReason === "user_cancelled") {
						return
					}
					throw error
				})
			}
		} catch (error) {
			if (t.abandoned === true || t.abort === true || t.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	// ── resumeTaskFromHistory ────────────────────────────────────────────

	async resumeTaskFromHistory(): Promise<void> {
		const t = this.host
		try {
			const modifiedClineMessages = await t.getSavedClineMessages()

			const lastRelevantMessageIndex = findLastIndex(
				modifiedClineMessages,
				(m: any) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
			)

			if (lastRelevantMessageIndex !== -1) {
				modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
			}

			while (modifiedClineMessages.length > 0) {
				const last = modifiedClineMessages[modifiedClineMessages.length - 1]
				if (last.type === "say" && last.say === "reasoning") {
					modifiedClineMessages.pop()
				} else {
					break
				}
			}

			const lastApiReqStartedIndex = findLastIndex(
				modifiedClineMessages,
				(m: any) => m.type === "say" && m.say === "api_req_started",
			)

			if (lastApiReqStartedIndex !== -1) {
				const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
				const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

				if (cost === undefined && cancelReason === undefined) {
					modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
				}
			}

			await t.overwriteClineMessages(modifiedClineMessages)
			t.clineMessages = await t.getSavedClineMessages()

			t.apiConversationHistory = await t.getSavedApiConversationHistory()

			t.errorRecovery.resetCompactFailure()

			const lastClineMessage = t.clineMessages
				.slice()
				.reverse()
				.find((m: any) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

			let askType: ClineAsk
			if (lastClineMessage?.ask === "completion_result") {
				askType = "resume_completed_task"
			} else {
				askType = "resume_task"
			}

			t.isInitialized = true

			const { response, text, images } = await t.ask(askType)

			let responseText: string | undefined
			let responseImages: string[] | undefined

			if (response === "messageResponse") {
				await t.say("user_feedback", text, images)
				responseText = text
				responseImages = images
			}

			const existingApiConversationHistory: ApiMessage[] = await t.getSavedApiConversationHistory()

			let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[]
			let modifiedApiConversationHistory: ApiMessage[]
			if (existingApiConversationHistory.length > 0) {
				const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

				if (lastMessage.isSummary) {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				} else if (lastMessage.role === "assistant") {
					const content = Array.isArray(lastMessage.content)
						? lastMessage.content
						: [{ type: "text" as const, text: lastMessage.content }]
					const hasToolUse = content.some(isToolUseBlock)

					if (hasToolUse) {
						const toolUseBlocks = content.filter(isToolUseBlock) as Anthropic.Messages.ToolUseBlock[]
						const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
							type: "tool_result" as const,
							tool_use_id: block.id,
							content: "Task was interrupted before this tool call could be completed.",
						}))
						modifiedApiConversationHistory = [...existingApiConversationHistory]
						modifiedOldUserContent = [...toolResponses]
					} else {
						modifiedApiConversationHistory = [...existingApiConversationHistory]
						modifiedOldUserContent = []
					}
				} else if (lastMessage.role === "user") {
					const previousAssistantMessage: ApiMessage | undefined =
						existingApiConversationHistory[existingApiConversationHistory.length - 2]

					const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(
						lastMessage.content,
					)
						? lastMessage.content
						: [{ type: "text" as const, text: lastMessage.content }]
					if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
						const assistantContent = Array.isArray(previousAssistantMessage.content)
							? previousAssistantMessage.content
							: [{ type: "text" as const, text: previousAssistantMessage.content }]

						const toolUseBlocks = assistantContent.filter(isToolUseBlock) as Anthropic.Messages.ToolUseBlock[]

						if (toolUseBlocks.length > 0) {
							const existingToolResults = existingUserContent.filter(
								(block) => block.type === "tool_result",
							) as Anthropic.ToolResultBlockParam[]

							const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
								.filter(
									(toolUse) =>
										!existingToolResults.some((result) => result.tool_use_id === toolUse.id),
								)
								.map((toolUse) => ({
									type: "tool_result" as const,
									tool_use_id: toolUse.id,
									content: "Task was interrupted before this tool call could be completed.",
								}))

							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
							modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
						} else {
							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
							modifiedOldUserContent = [...existingUserContent]
						}
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					throw new Error("Unexpected: Last message is not a user or assistant message")
				}
			} else {
				throw new Error("Unexpected: No existing API conversation history")
			}

			const newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

			const _agoText = ((): string => {
				const timestamp = lastClineMessage?.ts ?? Date.now()
				const now = Date.now()
				const diff = now - timestamp
				const minutes = Math.floor(diff / 60000)
				const hours = Math.floor(minutes / 60)
				const days = Math.floor(hours / 24)

				if (days > 0) {
					return `${days} day${days > 1 ? "s" : ""} ago`
				}
				if (hours > 0) {
					return `${hours} hour${hours > 1 ? "s" : ""} ago`
				}
				if (minutes > 0) {
					return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
				}
				return "just now"
			})()

			if (responseText) {
				newUserContent.push({
					type: "text",
					text: `<user_message>\n${responseText}\n</user_message>`,
				})
			}

			if (responseImages && responseImages.length > 0) {
				newUserContent.push(...formatResponse.imageBlocks(responseImages))
			}

			if (newUserContent.length === 0) {
				newUserContent.push({
					type: "text",
					text: "[TASK RESUMPTION] Resuming task...",
				})
			}

			await t.overwriteApiConversationHistory(modifiedApiConversationHistory)

			await t.initiateTaskLoop(newUserContent)
		} catch (error) {
			if (t.abandoned === true || t.abort === true || t.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	// ── emitTaskSessionMetricsSummary ────────────────────────────────────

	private emitTaskSessionMetricsSummary(trigger: "abort" | "dispose"): void {
		const t = this.host
		const cacheSummary = globalCacheMetrics.getSummary()
		const breakSummary = globalPromptCacheBreakDetector.getBreaksBySource()
		const payload = {
			timestamp: Date.now(),
			trigger,
			taskId: t.taskId,
			cacheRequests: cacheSummary.totalRequests,
			cacheHitRate: cacheSummary.cacheHitRate,
			cacheReadTokens: cacheSummary.totalCacheReadTokens,
			cacheCreationTokens: cacheSummary.totalCacheCreationTokens,
			estimatedSavingsPercent: cacheSummary.estimatedSavingsPercent,
			cacheBreaks: globalPromptCacheBreakDetector.getTotalBreaks(),
			cacheBreaksBySource: breakSummary,
		}
		logger.info("TaskLifecycleHandler",
			`Task Session Summary: trigger=${payload.trigger} task=${payload.taskId} cacheRequests=${payload.cacheRequests} cacheHitRate=${payload.cacheHitRate.toFixed(3)} cacheRead=${payload.cacheReadTokens} cacheCreate=${payload.cacheCreationTokens} estSavings=${(payload.estimatedSavingsPercent * 100).toFixed(1)}% cacheBreaks=${payload.cacheBreaks} breakBySource=${JSON.stringify(payload.cacheBreaksBySource)}`,
		)

		getTaskDirectoryPath(t.globalStoragePath, t.taskId)
			.then(async (taskDir: string) => {
				const metricsPath = path.join(taskDir, "task-metrics.jsonl")
				await fs.appendFile(metricsPath, `${JSON.stringify(payload)}\n`, "utf8")
			})
			.catch((error: any) => {
				logger.error("TaskLifecycleHandler", `Failed to persist metrics for task ${t.taskId}:`, error)
			})
	}

	// ── abortTask ────────────────────────────────────────────────────────

	async abortTask(isAbandoned = false): Promise<void> {
		const t = this.host

		if (isAbandoned) {
			t.abandoned = true
		}

		t.abort = true
		t.persistentRetryHandler?.cancel()
		t.persistentRetryHandler = undefined

		t.consecutiveNoToolUseCount = 0
		t.consecutiveNoAssistantMessagesCount = 0

		t.emitFinalTokenUsageUpdate()

		t.emit(NJUST_AI_CJEventName.TaskAborted)

		try {
			await t.saveClineMessages()
		} catch (error) {
			logger.error("TaskLifecycleHandler", `Error saving messages during abort for task ${t.taskId}.${t.instanceId}:`, error)
		}
		try {
			t.dispose()
		} catch (error) {
			logger.error("TaskLifecycleHandler", `Error during task ${t.taskId}.${t.instanceId} disposal:`, error)
		}
	}

	// ── dispose ──────────────────────────────────────────────────────────

	dispose(): void {
		const t = this.host

		if (t.isDisposed) {
			return
		}
		t.isDisposed = true

		logger.info("TaskLifecycleHandler", `Disposing task ${t.taskId}.${t.instanceId}`)
		this.emitTaskSessionMetricsSummary(t.abort ? "abort" : "dispose")
		clearMcpInstructionsDelta(t.taskId)

		try {
			deleteGeneratedCangjieTestFilesForTask(t.taskId)
		} catch (e) {
			logger.error("TaskLifecycleHandler", "Error deleting generated Cangjie test files:", e)
		}

		try {
			t.cancelCurrentRequest()
		} catch (error) {
			logger.error("TaskLifecycleHandler", "Error cancelling current request:", error)
		}

		try {
			if (t.providerProfileChangeListener) {
				const provider = t.hostRef.deref()
				if (provider) {
					provider.off(NJUST_AI_CJEventName.ProviderProfileChanged, t.providerProfileChangeListener)
				}
				t.providerProfileChangeListener = undefined
			}
		} catch (error) {
			logger.error("TaskLifecycleHandler", "Error removing provider profile change listener:", error)
		}

		try {
			if (t.messageQueueStateChangedHandler) {
				t.messageQueueService.removeListener("stateChanged", t.messageQueueStateChangedHandler)
				t.messageQueueStateChangedHandler = undefined
			}
			t.messageQueueService.dispose()
		} catch (error) {
			logger.error("TaskLifecycleHandler", "Error disposing message queue:", error)
		}

		try {
			t.removeAllListeners()
		} catch (error) {
			logger.error("TaskLifecycleHandler", "Error removing event listeners:", error)
		}

		try {
			TerminalRegistry.releaseTerminalsForTask(t.taskId)
		} catch (error) {
			logger.error("TaskLifecycleHandler", "Error releasing terminals:", error)
		}

		void getTaskDirectoryPath(t.globalStoragePath, t.taskId)
			.then((taskDir: string) => OutputInterceptor.cleanup(path.join(taskDir, "command-output")))
			.catch((error: any) => {
				logger.error("TaskLifecycleHandler", "Error cleaning up command output artifacts:", error)
			})

		safeDispose("RooIgnoreController", () => {
			if (t.rooIgnoreController) {
				t.rooIgnoreController.dispose()
				t.rooIgnoreController = undefined
			}
		})

		safeDispose("ToolExecution", () => t.toolExecution.dispose())
		safeDispose("FileContextTracker", () => t.fileContextTracker.dispose())

		safeDispose("DiffViewProvider", () => {
			if (t.isStreaming && t.diffViewProvider.isEditing) {
				t.diffViewProvider.revertChanges().catch((error: any) => logger.error("TaskLifecycleHandler", "DiffViewProvider revertChanges failed:", error))
			}
		})
	}
}
