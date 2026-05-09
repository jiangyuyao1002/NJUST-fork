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
import type { ClineMessage, ProviderSettings } from "@njust-ai-cj/types"
import { NJUST_AI_CJEventName, getApiProtocol, getModelId, isRetiredProvider } from "@njust-ai-cj/types"
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

	apiConfiguration: ProviderSettings

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
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
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

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.ctx.apiConfiguration)
			const apiProvider = this.ctx.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const isAnthropicProtocol = apiProtocol === "anthropic"

			// Start from the original assistant message
			const messageWithTs: any = {
				...message,
				...(responseId ? { id: responseId } : {}),
				ts: Date.now(),
			}

			// Store reasoning_details array if present (for models like Gemini 3)
			if (reasoningDetails) {
				messageWithTs.reasoning_details = reasoningDetails
			}

			// Store reasoning: Anthropic thinking (with signature), plain text (most providers), or encrypted (OpenAI Native)
			// Skip if reasoning_details already contains the reasoning (to avoid duplication)
			if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
				// Anthropic provider with extended thinking: Store as proper `thinking` block
				// This format passes through anthropic-filter.ts and is properly round-tripped
				// for interleaved thinking with tool use (required by Anthropic API)
				const thinkingBlock = {
					type: "thinking",
					thinking: reasoning,
					signature: thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						thinkingBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [thinkingBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thinkingBlock]
				}
			} else if (reasoning && !reasoningDetails) {
				// Other providers (non-Anthropic): Store as generic reasoning block
				const reasoningBlock = {
					type: "reasoning",
					text: reasoning,
					summary: reasoningSummary ?? ([] as any[]),
				}

				// Also store reasoning_content as a top-level field so that it
				// survives content-array transformations (e.g., buildCleanConversationHistory
				// converting the array to a string when the model doesn't set preserveReasoning).
				// DeepSeek/Z.ai require this field to be passed back in thinking mode.
				messageWithTs.reasoning_content = reasoning

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			} else if (reasoningData?.encrypted_content) {
				// OpenAI Native encrypted reasoning
				const reasoningBlock = {
					type: "reasoning",
					summary: [] as any[],
					encrypted_content: reasoningData.encrypted_content,
					...(reasoningData.id ? { id: reasoningData.id } : {}),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol) {
				const thoughtSignatureBlock = {
					type: "thoughtSignature",
					thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
						thoughtSignatureBlock,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...messageWithTs.content, thoughtSignatureBlock]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thoughtSignatureBlock]
				}
			}

			this.ctx.apiConversationHistory.push(messageWithTs)
		} else {
			// For user messages, validate tool_result IDs ONLY when the immediately previous *effective* message
			// is an assistant message.
			//
			// If the previous effective message is also a user message (e.g., summary + a new user message),
			// validating against any earlier assistant message can incorrectly inject placeholder tool_results.
			const effectiveHistoryForValidation = getEffectiveApiHistory(this.ctx.apiConversationHistory)
			const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
			const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []

			// If the previous effective message is NOT an assistant, convert tool_result blocks to text blocks.
			// This prevents orphaned tool_results from being filtered out by getEffectiveApiHistory.
			// This can happen when condensing occurs after the assistant sends tool_uses but before
			// the user responds - the tool_use blocks get condensed away, leaving orphaned tool_results.
			let messageToAdd = message
			if (lastEffective?.role !== "assistant" && Array.isArray(message.content)) {
				messageToAdd = {
					...message,
					content: message.content.map((block) =>
						block.type === "tool_result"
							? {
									type: "text" as const,
									text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
								}
							: block,
					),
				}
			}

			const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation)
			const messageWithTs = { ...validatedMessage, ts: Date.now() }
			this.ctx.apiConversationHistory.push(messageWithTs)
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

	findMessageById(id: string): ClineMessage | undefined {
		for (let i = this.ctx.clineMessages.length - 1; i >= 0; i--) {
			if (this.ctx.clineMessages[i].id === id) {
				return this.ctx.clineMessages[i]
			}
		}
		return undefined
	}
}
