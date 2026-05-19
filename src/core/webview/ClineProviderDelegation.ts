import * as vscode from "vscode"

import { NJUST_AI_CJEventName, type ClineMessage, type TodoItem, TelemetryEventName } from "@njust-ai-cj/types"

import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import type { Mode } from "../../shared/modes"
import type { Task } from "../task/Task"
import { readApiMessages, saveApiMessages, saveTaskMessages, type ApiMessage } from "../task-persistence"
import { readTaskMessages } from "../task-persistence/taskMessages"
import { validateAndFixToolResultIds } from "../task/validateToolResultIds"
import type { ClineProvider } from "./ClineProvider"
import { TelemetryService } from "@njust-ai-cj/telemetry"

export interface IDelegationHost {
	getCurrentTask(): Task | undefined
	log(message: string): void
	stack: { pop(options?: { skipDelegationRepair?: boolean }): Promise<void> }
	handleModeSwitch(mode: string): Promise<void>
	createTask(text: string, images?: string[], parentTask?: Task, options?: unknown): Promise<Task>
	getTaskWithId(id: string): Promise<{ historyItem: any }>
	updateTaskHistory(item: any, options?: any): Promise<any[]>
	emit(event: string, ...args: any[]): boolean
	readonly contextProxy: { globalStorageUri: { fsPath: string } }
	createTaskWithHistoryItem(historyItem: any, options?: { startTask?: boolean }): Promise<Task | undefined>
}

export async function delegateParentAndOpenChildWithProvider(provider: IDelegationHost, params: {
		parentTaskId: string
		message: string
		initialTodos: TodoItem[]
		mode: string
		isolationLevel?: string
		forkedContextSummary?: string
	}): Promise<Task> {
		const { parentTaskId, message, initialTodos, mode, isolationLevel, forkedContextSummary } = params

		// Metadata-driven delegation is always enabled

		// 1) Get parent (must be current task)
		const parent = provider.getCurrentTask()
		if (!parent) {
			throw new Error("[delegateParentAndOpenChild] No current task")
		}
		if (parent.taskId !== parentTaskId) {
			throw new Error(
				`[delegateParentAndOpenChild] Parent mismatch: expected ${parentTaskId}, current ${parent.taskId}`,
			)
		}
		// 2) Flush pending tool results to API history BEFORE disposing the parent.
		//    This is critical: when tools are called before new_task,
		//    their tool_result blocks are in userMessageContent but not yet saved to API history.
		//    If we don't flush them, the parent's API conversation will be incomplete and
		//    cause 400 errors when resumed (missing tool_result for tool_use blocks).
		//
		//    NOTE: We do NOT pass the assistant message here because the assistant message
		//    is already added to apiConversationHistory by the normal flow in
		//    recursivelyMakeClineRequests BEFORE tools start executing. We only need to
		//    flush the pending user message with tool_results.
		try {
			const flushSuccess = await parent.flushPendingToolResultsToHistory()

			if (!flushSuccess) {
				logger.warn("ClineProvider", `delegateParentAndOpenChild: Flush failed for parent ${parentTaskId}, retrying...`)
				const retrySuccess = await parent.retrySaveApiConversationHistory()

				if (!retrySuccess) {
					logger.error(
						"ClineProvider",
						`delegateParentAndOpenChild: CRITICAL: Parent ${parentTaskId} API history not persisted to disk. Child return may produce stale state.`,
					)
					vscode.window.showWarningMessage(
						"Warning: Parent task state could not be saved. The parent task may lose recent context when resumed.",
					)
				}
			}
		} catch (error) {
			provider.log(
				`[delegateParentAndOpenChild] Error flushing pending tool results (non-fatal): ${
					getErrorMessage(error)
				}`,
			)
		}

		// 3) Enforce single-open invariant by closing/disposing the parent first
		//    This ensures we never have >1 tasks open at any time during delegation.
		//    Await abort completion to ensure clean disposal and prevent unhandled rejections.
		try {
			await provider.stack.pop({ skipDelegationRepair: true })
		} catch (error) {
			provider.log(
				`[delegateParentAndOpenChild] Error during parent disposal (non-fatal): ${
					getErrorMessage(error)
				}`,
			)
			// Non-fatal: proceed with child creation even if parent cleanup had issues
		}

		// 3) Switch provider mode to child's requested mode BEFORE creating the child task
		//    This ensures the child's system prompt and configuration are based on the correct mode.
		//    The mode switch must happen before createTask() because the Task constructor
		//    initializes its mode from provider.getState() during initializeTaskMode().
		try {
			await provider.handleModeSwitch(mode as Mode)
		} catch (e) {
			provider.log(
				`[delegateParentAndOpenChild] handleModeSwitch failed for mode '${mode}': ${
					(e as Error)?.message ?? String(e)
				}`,
			)
		}

		// 4) Create child as sole active (parent reference preserved for lineage)
		// Pass initialStatus: "active" to ensure the child task's historyItem is created
		// with status from the start, avoiding race conditions where the task might
		// call attempt_completion before status is persisted separately.
		//
		// Pass startTask: false to prevent the child from beginning its task loop
		// (and writing to globalState via saveClineMessages → updateTaskHistory)
		// before we persist the parent's delegation metadata in step 5.
		// Without this, the child's fire-and-forget startTask() races with step 5,
		// and the last writer to globalState overwrites the other's changes—
		// causing the parent's delegation fields to be lost.
		const child = await provider.createTask(message, undefined, parent, {
			initialTodos,
			initialStatus: "active",
			startTask: false,
		})
		// Inherit streaming model snapshot for better prompt-cache/tool-schema reuse continuity.
		if (parent.cachedStreamingModel) {
			child.cachedStreamingModel = parent.cachedStreamingModel
		}

		// Apply forked isolation context if specified
		let effectiveForkedSummary = forkedContextSummary
		if (isolationLevel === "forked" && !effectiveForkedSummary) {
			// Auto-generate context summary from parent when caller (e.g. NewTaskTool)
			// requests forked isolation but doesn't provide a pre-built summary.
			try {
				const { generateParentContextSummary } = await import("../task/SubTaskContextBuilder")
				const { DEFAULT_FORKED_CONTEXT_CONFIG } = await import("../task/SubTaskOptions")
				if (parent.apiConversationHistory && parent.apiConversationHistory.length > 0) {
					effectiveForkedSummary = generateParentContextSummary(
						parent.apiConversationHistory,
						DEFAULT_FORKED_CONTEXT_CONFIG.summaryMaxTokens,
						DEFAULT_FORKED_CONTEXT_CONFIG,
					)
				}
			} catch (e) {
				provider.log(
					`[delegateParentAndOpenChild] Failed to auto-generate forked context summary: ${
						(e as Error)?.message ?? String(e)
					}`,
				)
			}
		}
		if (isolationLevel === "forked" && effectiveForkedSummary) {
			child.forkedContextSummary = effectiveForkedSummary
			child.isolationLevel = "forked"
		}

		// 5) Persist parent delegation metadata BEFORE the child starts writing.
		try {
			const { historyItem } = await provider.getTaskWithId(parentTaskId)
			const childIds = Array.from(new Set([...(historyItem.childIds ?? []), child.taskId]))
			const updatedHistory: typeof historyItem = {
				...historyItem,
				status: "delegated",
				delegatedToId: child.taskId,
				awaitingChildId: child.taskId,
				childIds,
			}
			await provider.updateTaskHistory(updatedHistory)
		} catch (err) {
			provider.log(
				`[delegateParentAndOpenChild] Failed to persist parent metadata for ${parentTaskId} -> ${child.taskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 6) Start the child task now that parent metadata is safely persisted.
		child.start()

		// 7) Emit TaskDelegated (provider-level)
		try {
			provider.emit(NJUST_AI_CJEventName.TaskDelegated, parentTaskId, child.taskId)
		} catch (error) {
			// non-fatal
			logger.warn("ClineProvider", "TaskDelegated event emission failed", error)
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
		}

		return child
	}

export async function reopenParentFromDelegationWithProvider(provider: IDelegationHost, params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
	}): Promise<void> {
		const { parentTaskId, childTaskId, completionResultSummary } = params
		const globalStoragePath = provider.contextProxy.globalStorageUri.fsPath

		// 1) Load parent from history and current persisted messages
		const { historyItem } = await provider.getTaskWithId(parentTaskId)

		let parentClineMessages: ClineMessage[] = []
		try {
			parentClineMessages = await readTaskMessages({
				taskId: parentTaskId,
				globalStoragePath,
			})
		} catch (error) {
			logger.debug("ClineProvider", "Failed to read parent cline messages", error)
			parentClineMessages = []
		}

		let parentApiMessages: ApiMessage[] = []
		try {
			parentApiMessages = (await readApiMessages({
				taskId: parentTaskId,
				globalStoragePath,
			}))
		} catch (error) {
			logger.debug("ClineProvider", "Failed to read parent api messages", error)
			parentApiMessages = []
		}

		// 2) Inject synthetic records: UI subtask_result and update API tool_result
		const ts = Date.now()

		// Defensive: ensure arrays
		if (!Array.isArray(parentClineMessages)) parentClineMessages = []
		if (!Array.isArray(parentApiMessages)) parentApiMessages = []

		const subtaskUiMessage: ClineMessage = {
			type: "say",
			say: "subtask_result",
			text: completionResultSummary,
			ts,
				id: crypto.randomUUID(),
		}
		parentClineMessages.push(subtaskUiMessage)
		await saveTaskMessages({ messages: parentClineMessages, taskId: parentTaskId, globalStoragePath })

		// Find the tool_use_id from the last assistant message's new_task tool_use
		let toolUseId: string | undefined
		for (let i = parentApiMessages.length - 1; i >= 0; i--) {
			const msg = parentApiMessages[i]
			if (!msg) continue
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use" && block.name === "new_task") {
						toolUseId = block.id
						break
					}
				}
				if (toolUseId) break
			}
		}

		// Preferred: if the parent history contains the native tool_use for new_task,
		// inject a matching tool_result for the Anthropic message contract:
		// user → assistant (tool_use) → user (tool_result)
		if (toolUseId) {
			// Check if the last message is already a user message with a tool_result for this tool_use_id
			// (in case this is a retry or the history was already updated)
			const lastMsg = parentApiMessages[parentApiMessages.length - 1]
			let alreadyHasToolResult = false
			if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
				for (const block of lastMsg.content) {
					if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
						// Update the existing tool_result content
						block.content = `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`
						alreadyHasToolResult = true
						break
					}
				}
			}

			// If no existing tool_result found, create a NEW user message with the tool_result
			if (!alreadyHasToolResult) {
				parentApiMessages.push({
					role: "user",
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: toolUseId,
							content: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
						},
					],
					ts,
				})
			}

			// Validate the newly injected tool_result against the preceding assistant message.
			// This ensures the tool_result's tool_use_id matches a tool_use in the immediately
			// preceding assistant message (Anthropic API requirement).
			const lastMessage = parentApiMessages[parentApiMessages.length - 1]
			if (lastMessage?.role === "user") {
				const validatedMessage = validateAndFixToolResultIds(lastMessage, parentApiMessages.slice(0, -1))
				parentApiMessages[parentApiMessages.length - 1] = validatedMessage
			}
		} else {
			// If there is no corresponding tool_use in the parent API history, we cannot emit a
			// tool_result. Fall back to a plain user text note so the parent can still resume.
			parentApiMessages.push({
				role: "user",
				content: [
					{
						type: "text" as const,
						text: `Subtask ${childTaskId} completed.\n\nResult:\n${completionResultSummary}`,
					},
				],
				ts,
			})
		}

		await saveApiMessages({ messages: parentApiMessages, taskId: parentTaskId, globalStoragePath })

		// 3) Close child instance if still open (single-open-task invariant).
		//    This MUST happen BEFORE updating the child's status to "completed" because
		//    stack.pop() → abortTask(true) → saveClineMessages() writes
		//    the historyItem with initialStatus (typically "active"), which would
		//    overwrite a "completed" status set earlier.
		const current = provider.getCurrentTask()
		if (current?.taskId === childTaskId) {
			await provider.stack.pop()
		}

		// 4) Update child metadata to "completed" status.
		//    This runs after the abort so it overwrites the stale "active" status
		//    that saveClineMessages() may have written during step 3.
		try {
			const { historyItem: childHistory } = await provider.getTaskWithId(childTaskId)
			await provider.updateTaskHistory({
				...childHistory,
				status: "completed",
			})
		} catch (err) {
			provider.log(
				`[reopenParentFromDelegation] Failed to persist child completed status for ${childTaskId}: ${
					(err as Error)?.message ?? String(err)
				}`,
			)
		}

		// 5) Update parent metadata and persist BEFORE emitting completion event
		const childIds = Array.from(new Set([...(historyItem.childIds ?? []), childTaskId]))
		const updatedHistory: typeof historyItem = {
			...historyItem,
			status: "active",
			completedByChildId: childTaskId,
			completionResultSummary,
			awaitingChildId: undefined,
			childIds,
		}
		await provider.updateTaskHistory(updatedHistory)

		// 6) Emit TaskDelegationCompleted (provider-level)
		try {
			provider.emit(NJUST_AI_CJEventName.TaskDelegationCompleted, parentTaskId, childTaskId, completionResultSummary)
		} catch (error) {
			// non-fatal
			logger.warn("ClineProvider", "TaskDelegationCompleted event emission failed", error)
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
		}

		// 7) Reopen the parent from history as the sole active task (restores saved mode)
		//    IMPORTANT: startTask=false to suppress resume-from-history ask scheduling
		const parentInstance = await provider.createTaskWithHistoryItem(updatedHistory, { startTask: false })

		// 8) Inject restored histories into the in-memory instance before resuming
		if (parentInstance) {
			try {
				await parentInstance.overwriteClineMessages(parentClineMessages)
			} catch (error) {
				// non-fatal
				logger.warn("ClineProvider", "overwriteClineMessages failed", error)
				TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			}
			try {
				await parentInstance.overwriteApiConversationHistory(parentApiMessages)
			} catch (error) {
				// non-fatal
				logger.warn("ClineProvider", "overwriteApiConversationHistory failed", error)
				TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
			}

			// Auto-resume parent without ask("resume_task")
			await parentInstance.resumeAfterDelegation()
		}

		// 9) Emit TaskDelegationResumed (provider-level)
		try {
			provider.emit(NJUST_AI_CJEventName.TaskDelegationResumed, parentTaskId, childTaskId)
		} catch (error) {
			// non-fatal
			logger.warn("ClineProvider", "TaskDelegationResumed event emission failed", error)
			TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
		}
	}

