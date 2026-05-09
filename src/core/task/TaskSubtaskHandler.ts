/**
 * TaskSubtaskHandler — Subtask orchestration handling.
 *
 * Extracted from Task.ts to decompose the monolithic file. Handles startSubtask()
 * and resumeAfterDelegation() operations.
 *
 * Phase 1: Extract subtask logic from Task.ts
 */
import type { ApiMessage } from "../task-persistence"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { TaskSubtaskHost } from "./interfaces/TaskSubtaskHost"
import { NJUST_AI_CJEventName } from "@njust-ai-cj/types"
import { generateParentContextSummary } from "./SubTaskContextBuilder"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { DEFAULT_FORKED_CONTEXT_CONFIG } from "./SubTaskOptions"
import type { IsolationLevel, ForkedContextConfig, CacheSafeParams } from "./SubTaskOptions"
import type { TodoItem } from "@njust-ai-cj/types"

export class TaskSubtaskHandler {
	constructor(private host: TaskSubtaskHost) {}

	async startSubtask(
		message: string,
		initialTodos: TodoItem[],
		mode: string,
		isolationLevel: IsolationLevel = "shared",
		forkedConfig?: ForkedContextConfig,
		cacheSafeParams?: CacheSafeParams,
	) {
		const provider = this.host.hostRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		let forkedContextSummary: string | undefined
		let effectiveCacheSafeParams: CacheSafeParams | undefined

		if (isolationLevel === "forked") {
			if (cacheSafeParams) {
				effectiveCacheSafeParams = cacheSafeParams
				forkedContextSummary = message
			} else {
				const config = forkedConfig ?? DEFAULT_FORKED_CONTEXT_CONFIG
				forkedContextSummary = generateParentContextSummary(
					this.host.apiConversationHistory,
					config.summaryMaxTokens,
					config,
				)
			}
		}

		const child = await provider.delegateParentAndOpenChild({
			parentTaskId: this.host.taskId,
			message,
			initialTodos,
			mode,
			isolationLevel,
			forkedContextSummary,
			cacheSafeParams: effectiveCacheSafeParams,
		})
		return child
	}

	async resumeAfterDelegation(): Promise<void> {
		this.host.idleAsk = undefined
		this.host.resumableAsk = undefined
		this.host.interactiveAsk = undefined

		this.host.abort = false
		this.host.abandoned = false
		this.host.abortReason = undefined
		this.host.didFinishAbortingStream = false
		this.host.isStreaming = false
		this.host.isWaitingForFirstChunk = false

		this.host.skipPrevResponseIdOnce = true

		this.host.isInitialized = true
		this.host.emit(NJUST_AI_CJEventName.TaskActive, this.host.taskId)

		if (this.host.apiConversationHistory.length === 0) {
			this.host.apiConversationHistory = await this.host.getSavedApiConversationHistory()
		}

		const environmentDetails = await getEnvironmentDetails(this.host as any, true)
		let lastUserMsgIndex = -1
		for (let i = this.host.apiConversationHistory.length - 1; i >= 0; i--) {
			const msg = this.host.apiConversationHistory[i]
			if (msg.role === "user") {
				lastUserMsgIndex = i
				break
			}
		}
		if (lastUserMsgIndex >= 0) {
			const lastUserMsg = this.host.apiConversationHistory[lastUserMsgIndex]
			if (Array.isArray(lastUserMsg.content)) {
				const contentWithoutEnvDetails = lastUserMsg.content.filter(
					(block: Anthropic.Messages.ContentBlockParam) => {
						if (block.type === "text" && typeof block.text === "string") {
							const isEnvironmentDetailsBlock =
								block.text.trim().startsWith("<environment_details>") &&
								block.text.trim().endsWith("</environment_details>")
							return !isEnvironmentDetailsBlock
						}
						return true
					},
				)
				lastUserMsg.content = [
					...contentWithoutEnvDetails,
					{ type: "text" as const, text: environmentDetails },
				]
			}
		}

		await this.host.saveApiConversationHistory()

		await this.host.initiateTaskLoop([])
	}
}
