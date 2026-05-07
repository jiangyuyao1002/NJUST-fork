/**
 * TaskMessageManager — Manages API conversation history and ClineMessage persistence.
 *
 * Extracted from Task.ts to decompose the monolithic file. Owns persistence
 * operations for both API messages and UI (Cline) messages.
 *
 * Phase 1: persistence and CRUD helpers.
 * Phase 2 (future): move ask/say control flow here once the state surface
 * is reduced via further decoupling.
 */
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ClineMessage } from "@njust-ai-cj/types"
import { NJUST_AI_CJEventName } from "@njust-ai-cj/types"
import { defaultModeSlug } from "../../shared/modes"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEffectiveApiHistory } from "../condense"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import type { ApiHandler } from "../../api"
import { logger } from "../../shared/logger"

/**
 * Minimal surface the message manager needs from its owning Task.
 * Avoids a hard import of Task (breaks the circular dependency risk).
 */
export interface TaskMessageContext {
	readonly taskId: string
	readonly instanceId: string
	readonly globalStoragePath: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	readonly taskNumber: number

	abort: boolean
	apiConversationHistory: ApiMessage[]
	clineMessages: ClineMessage[]
	userMessageContent: Anthropic.Messages.ContentBlockParam[]
	assistantMessageSavedToHistory: boolean
	lastMessageTs: number

	readonly api: ApiHandler

	_taskMode: string | undefined
	_taskApiConfigName: string | undefined
	taskApiConfigReady: Promise<void>
	initialStatus?: "active" | "delegated" | "completed"

	cwd: string
	debouncedEmitTokenUsage: (tokenUsage: any, toolUsage: any) => void
	toolUsage: any

	emit(event: string, ...args: any[]): boolean

	notifier?: {
		postStateToWebviewWithoutTaskHistory(): Promise<void>
		postMessageToWebview(message: any): Promise<void>
		updateTaskHistory(item: any): Promise<void>
	}
}

export class TaskMessageManager {
	constructor(private ctx: TaskMessageContext) {}

	async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({
			taskId: this.ctx.taskId,
			globalStoragePath: this.ctx.globalStoragePath,
		})
	}

	async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<void> {
		const handler = this.ctx.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()

			const extendedMessage: any = { ...message, ts: Date.now() }

			if (responseId) {
				extendedMessage.providerResponseId = responseId
			}
			if (reasoningData) {
				extendedMessage.providerEncryptedContent = reasoningData
			}
			if (thoughtSignature) {
				extendedMessage.providerThoughtSignature = thoughtSignature
			}
			if (reasoning) {
				extendedMessage.reasoning = reasoning
			}
			if (reasoningSummary) {
				extendedMessage.reasoningSummary = reasoningSummary
			}
			if (reasoningDetails) {
				extendedMessage.reasoningDetails = reasoningDetails
			}

			this.ctx.apiConversationHistory.push(extendedMessage as ApiMessage)
		} else {
			this.ctx.apiConversationHistory.push({ ...message, ts: Date.now() } as ApiMessage)
		}

		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]): Promise<void> {
		this.ctx.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	async flushPendingToolResultsToHistory(): Promise<boolean> {
		if (this.ctx.userMessageContent.length === 0) {
			return true
		}

		if (!this.ctx.assistantMessageSavedToHistory) {
			const pWaitFor = (await import("p-wait-for")).default
			await pWaitFor(() => this.ctx.assistantMessageSavedToHistory || this.ctx.abort, {
				interval: 50,
				timeout: 30_000,
			}).catch(() => {
				logger.warn("TaskMessageManager",
					`flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved for task ${this.ctx.taskId}`,
				)
			})
		}

		if (this.ctx.abort) {
			return false
		}

		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: this.ctx.userMessageContent,
		}

		const effectiveHistoryForValidation = getEffectiveApiHistory(this.ctx.apiConversationHistory)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation)
		const userMessageWithTs = { ...validatedMessage, ts: Date.now() }
		this.ctx.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await this.saveApiConversationHistory()

		if (saved) {
			this.ctx.userMessageContent = []
		} else {
			logger.warn("TaskMessageManager",
				`flushPendingToolResultsToHistory: save failed for task ${this.ctx.taskId}, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.ctx.apiConversationHistory),
				taskId: this.ctx.taskId,
				globalStoragePath: this.ctx.globalStoragePath,
			})
			return true
		} catch (error) {
			logger.error("TaskMessageManager", "Failed to save API conversation history:", error)
			return false
		}
	}

	async retrySaveApiConversationHistory(): Promise<boolean> {
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
			logger.warn("TaskMessageManager",
				`retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length} for task ${this.ctx.taskId}`,
			)

			const success = await this.saveApiConversationHistory()
			if (success) {
				return true
			}
		}

		return false
	}

	// ── ClineMessage persistence ─────────────────────────────────────────

	async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({
			taskId: this.ctx.taskId,
			globalStoragePath: this.ctx.globalStoragePath,
		})
	}

	async addToClineMessages(message: ClineMessage): Promise<void> {
		this.ctx.clineMessages.push(message)
		await this.ctx.notifier?.postStateToWebviewWithoutTaskHistory()
		this.ctx.emit(NJUST_AI_CJEventName.Message, { action: "created", message })
		await this.saveClineMessages()
	}

	async overwriteClineMessages(newMessages: ClineMessage[]): Promise<void> {
		this.ctx.clineMessages = newMessages
		restoreTodoListForTask(this.ctx as any)
		await this.saveClineMessages()
	}

	async updateClineMessage(message: ClineMessage): Promise<void> {
		await this.ctx.notifier?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.ctx.emit(NJUST_AI_CJEventName.Message, { action: "updated", message })
	}

	async saveClineMessages(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.ctx.clineMessages),
				taskId: this.ctx.taskId,
				globalStoragePath: this.ctx.globalStoragePath,
			})

			if (this.ctx._taskApiConfigName === undefined) {
				await this.ctx.taskApiConfigReady
			}

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.ctx.taskId,
				rootTaskId: this.ctx.rootTaskId,
				parentTaskId: this.ctx.parentTaskId,
				taskNumber: this.ctx.taskNumber,
				messages: this.ctx.clineMessages,
				globalStoragePath: this.ctx.globalStoragePath,
				workspace: this.ctx.cwd,
				mode: this.ctx._taskMode || defaultModeSlug,
				apiConfigName: this.ctx._taskApiConfigName,
				initialStatus: this.ctx.initialStatus,
			})

			this.ctx.debouncedEmitTokenUsage(tokenUsage, this.ctx.toolUsage)
			await this.ctx.notifier?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			logger.error("TaskMessageManager", "Failed to save Roo messages:", error)
			return false
		}
	}

	findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.ctx.clineMessages.length - 1; i >= 0; i--) {
			if (this.ctx.clineMessages[i].ts === ts) {
				return this.ctx.clineMessages[i]
			}
		}
		return undefined
	}
}
