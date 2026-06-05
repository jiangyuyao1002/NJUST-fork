/**
 * TaskExecutor — Owns the LLM conversation loop and API request lifecycle.
 *
 * Phase 2: `attemptApiRequest` and `recursivelyMakeClineRequests` live here.
 * Task.ts retains same-signature public facades that delegate to this module.
 *
 * The executor receives the owning Task instance (typed as `TaskExecutorHost`)
 * and accesses state / methods through that reference. This avoids circular
 * class imports — only the host *interface* is imported here.
 */
import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"
export type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"

import type { ClineMessage, ClineApiReqInfo, ContextCondense, ContextTruncation } from "@njust-ai/types"
import {
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
	TelemetryEventName,
} from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import type { ApiHandlerCreateMessageMetadata } from "../../api"
import { resolveParallelNativeToolCalls } from "../../shared/parallelToolCalls"
import { type ApiStream } from "../../api/transform/stream"
import { checkToolPromptConsistency } from "../prompts/toolPromptConsistency"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { ApiMessage } from "../task-persistence"
import { getModelMaxOutputTokens } from "../../shared/api"
import { globalPromptCacheBreakDetector } from "../prompts/promptCacheBreakDetection"
import { globalQueryProfiler } from "../../utils/queryProfiler"
import type { ToolUse, McpToolUse } from "../../shared/tools"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { clearRetryEvents } from "../errors/retryPersistence"
import { manageContext, willManageContext } from "../context-management"
import { getMessagesSinceLastSummary, getEffectiveApiHistory } from "../condense"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"
import { PersistentRetryManager } from "./PersistentRetry"
import { TaskState } from "./TaskStateMachine"
import { formatResponse } from "../prompts/responses"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { t as i18nT } from "../../i18n"
import { processUserContentMentions } from "../mentions/processUserContentMentions"

import { debugLog } from "../../utils/debugLog"
import { TaskAbortedError, TaskAutoApprovalError } from "./TaskErrors"
import { TokenBucketRateLimiter } from "../../services/rate-limiter/TokenBucketRateLimiter"
import { BackpressureController } from "../stream/BackpressureController"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { handleAttemptApiRequestError } from "./TaskRetryHandler"
import { consumeApiStream, finalizeStreamResponse, type StackItem, type FinalizeToolUseFn } from "./TaskStreamConsumer"
import { findLastIndex } from "../../shared/array"

// ── Host interface ───────────────────────────────────────────────────────
// Structural contract: Task implements this shape at runtime.
// We never `import { Task }` here to avoid circular dependency.
// TaskExecutorHost is now defined in ./interfaces/ITaskExecutorHost.ts

// ── Executor ─────────────────────────────────────────────────────────────

export class TaskExecutor {
	private readonly toolCallParser = new NativeToolCallParser()
	constructor(private host: TaskExecutorHost) {}

	private placeFinalizedStreamingToolUse(
		t: TaskExecutorHost,
		id: string,
		finalToolUse: ToolUse | McpToolUse,
	): ToolUse | McpToolUse {
		finalToolUse.id = id

		const toolUseIndex = t.streamingToolCallIndices.get(id)
		if (toolUseIndex !== undefined) {
			t.assistantMessageContent[toolUseIndex] = finalToolUse
		} else {
			t.assistantMessageContent.push(finalToolUse)
		}

		t.streamingToolCallIndices.delete(id)
		t.userMessageContentReady = false

		return finalToolUse
	}

	/**
	 * Attempt a single API request with error handling, retry, and context management.
	 * Migrated from Task.ts — the original method body is preserved verbatim.
	 */
	async *attemptApiRequest(retryAttempt: number = 0, options: { skipProviderRateLimit?: boolean } = {}): ApiStream {
		const h = this.host

		if (h.parentTask) {
			this.checkSubtaskTokenBudget()
		}

		// If we're in STREAMING state (e.g., previous stream was interrupted),
		// transition to COMPLETED first to allow a clean PREPARING transition.
		if (h.stateMachine.state === TaskState.STREAMING) {
			h.stateMachine.force(TaskState.COMPLETED)
		}
		h.stateMachine.force(TaskState.PREPARING)
		if (h.abort) {
			throw new TaskAbortedError(h.taskId, h.instanceId)
		}
		const state = await h.hostRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
			profileThresholds = {},
		} = state ?? {}
		const unattendedRetryEnabled = state?.unattendedRetryEnabled ?? false
		const unattendedMaxRetryAttempts = state?.unattendedMaxRetryAttempts ?? 5

		const _enablePersistentRetry = state?.enablePersistentRetry ?? false
		h.persistentRetryHandler ??= new PersistentRetryManager()

		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit && !h._rateLimitAlreadyWaitedForThisRequest) {
			await h.streamProcessor.maybeWaitForProviderRateLimit(retryAttempt)
		}

		h.setLastGlobalApiRequestTime(performance.now())

		void h.requestBuilder.prefetchSystemPromptData()
		const systemPromptPartsPromise = h.requestBuilder.getSystemPromptParts()
		const tokenUsagePromise = Promise.resolve(h.getTokenUsage())
		const modelSnapshotPromise = Promise.resolve(h.api.getModel())

		const lastMessage = h.apiConversationHistory[h.apiConversationHistory.length - 1]
		const lastMessageContent = lastMessage?.content
		const lastMsgTokensPromise = lastMessageContent
			? Array.isArray(lastMessageContent)
				? h.api.countTokens(lastMessageContent)
				: h.api.countTokens([{ type: "text", text: lastMessageContent as string }])
			: Promise.resolve(0)

		const [systemPromptParts, tokenUsage, modelSnapshot, lastMessageTokens] = await Promise.all([
			systemPromptPartsPromise,
			tokenUsagePromise,
			modelSnapshotPromise,
			lastMsgTokensPromise,
		])
		const systemPrompt = systemPromptParts.fullPrompt

		const cacheBreak = globalPromptCacheBreakDetector.check(
			systemPromptParts.staticPart,
			systemPromptParts.dynamicPart,
			systemPromptParts.perToolHashes,
		)
		if (cacheBreak) {
			logger.info(
				"TaskExecutor",
				`Prompt Cache break: source=${cacheBreak.changeSource} staticChanged=${cacheBreak.staticPartChanged} dynamicChanged=${cacheBreak.dynamicPartChanged} changedTools=${(cacheBreak.changedTools ?? []).join(",") || "none"}`,
			)
		}
		const { contextTokens } = tokenUsage
		const cacheReadTokens = h.requestCacheReadWindow.length
			? Math.round(h.requestCacheReadWindow.reduce((sum, n) => sum + n, 0) / h.requestCacheReadWindow.length)
			: undefined
		const cacheAwareTotalTokens = h.requestInputTokensWindow.length
			? Math.max(
					1,
					Math.round(
						h.requestInputTokensWindow.reduce((sum, n) => sum + n, 0) / h.requestInputTokensWindow.length,
					),
				)
			: undefined

		if (contextTokens) {
			const modelInfo = modelSnapshot.info

			const maxTokens = getModelMaxOutputTokens({
				modelId: modelSnapshot.id,
				model: modelInfo,
				settings: h.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			const currentProfileId = h.streamProcessor.getCurrentProfileId(state)
			const ctxProvider = h.hostRef.deref()
			const contextMgmtToolsPromise = ctxProvider
				? buildNativeToolsArrayWithRestrictions({
						provider: ctxProvider,
						cwd: h.cwd,
						mode,
						customModes: state?.customModes,
						experiments: state?.experiments,
						apiConfiguration,
						disabledTools: state?.disabledTools,
						enableWebSearch: state?.enableWebSearch,
						modelInfo,
						includeAllToolsWithRestrictions: false,
					})
				: Promise.resolve({ tools: [] as OpenAI.Chat.ChatCompletionTool[] })

			h.tokenGrowthTracker.addSample(contextTokens + lastMessageTokens)
			const growthSnapshot = h.tokenGrowthTracker.getSnapshot()
			const predictedTotalTokens = growthSnapshot?.predictedNextTokens ?? contextTokens

			const contextManagementWillRun = willManageContext({
				totalTokens: Math.max(contextTokens, predictedTotalTokens),
				contextWindow,
				maxTokens,
				autoCondenseContext,
				autoCondenseContextPercent,
				profileThresholds,
				currentProfileId,
				lastMessageTokens,
			})

			if (contextManagementWillRun && autoCondenseContext) {
				await h.hostRef.deref()?.postMessageToWebview({ type: "condenseTaskContextStarted", text: h.taskId })
			}

			const contextMgmtTools: OpenAI.Chat.ChatCompletionTool[] = contextManagementWillRun
				? (await contextMgmtToolsPromise).tools
				: []

			const contextMgmtMetadata: ApiHandlerCreateMessageMetadata = {
				mode,
				taskId: h.taskId,
				...(contextMgmtTools.length > 0
					? {
							tools: contextMgmtTools,
							tool_choice: "auto",
							parallelToolCalls: resolveParallelNativeToolCalls(apiConfiguration),
						}
					: {}),
			}

			const [contextMgmtEnvironmentDetails, contextMgmtFilesReadByRoo] = contextManagementWillRun
				? await Promise.all([
						getEnvironmentDetails(h as UnsafeAny, true),
						autoCondenseContext
							? h.streamProcessor.getFilesReadByRooSafely("attemptApiRequest")
							: Promise.resolve(undefined),
					])
				: [undefined, undefined]

			try {
				const shouldBypassCondense = h.errorRecovery.shouldBypassCondense()
				const truncateResult = await manageContext({
					messages: h.apiConversationHistory,
					totalTokens: contextTokens,
					maxTokens,
					contextWindow,
					apiHandler: h.api,
					autoCondenseContext: shouldBypassCondense ? false : autoCondenseContext,
					autoCondenseContextPercent,
					systemPrompt,
					taskId: h.taskId,
					customCondensingPrompt,
					profileThresholds,
					currentProfileId,
					metadata: contextMgmtMetadata,
					environmentDetails: contextMgmtEnvironmentDetails,
					filesReadByRoo: contextMgmtFilesReadByRoo,
					cwd: h.cwd,
					rooIgnoreController: h.rooIgnoreController as UnsafeAny,
					enableMicroCompact: true,
					cacheReadTokens,
					cacheAwareTotalTokens,
					compactFailures: h.compactFailureCount,
					isSubAgent: h.parentTask !== undefined,
				})
				h.compactFailureCount = truncateResult.compactFailures ?? 0
				if (truncateResult.messages !== h.apiConversationHistory) {
					await h.overwriteApiConversationHistory(truncateResult.messages)
				}
				if (truncateResult.error) {
					await h.errorRecovery.recordCompactFailure(truncateResult.error)
				}
				if (truncateResult.summary) {
					h.errorRecovery.resetCompactFailure()
					const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
					const contextCondense: ContextCondense = {
						summary,
						cost,
						newContextTokens,
						prevContextTokens,
						condenseId,
					}
					await h.say(
						"condense_context",
						undefined,
						undefined,
						false,
						undefined,
						undefined,
						{ isNonInteractive: true },
						contextCondense,
					)
				} else if (truncateResult.truncationId) {
					const contextTruncation: ContextTruncation = {
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved ?? 0,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
					}
					await h.say(
						"sliding_window_truncation",
						undefined,
						undefined,
						false,
						undefined,
						undefined,
						{ isNonInteractive: true },
						undefined,
						contextTruncation,
					)
				}
			} finally {
				if (contextManagementWillRun && autoCondenseContext) {
					await h.hostRef
						.deref()
						?.postMessageToWebview({ type: "condenseTaskContextResponse", text: h.taskId })
				}
			}
		}

		const effectiveHistory = getEffectiveApiHistory(h.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, h.api)
		const cleanConversationHistory = h.streamProcessor.buildCleanConversationHistory(
			messagesWithoutImages as ApiMessage[],
		)

		const approvalResult = await h.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			h.combineMessages(h.clineMessages.slice(1)),
			async (type: UnsafeAny, data: UnsafeAny) => h.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			throw new TaskAutoApprovalError("Auto-approval limit reached and user did not approve continuation")
		}

		const modelInfo = modelSnapshot.info

		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		const provider = h.hostRef.deref()
		if (!provider) {
			throw new Error("Provider reference lost during tool building")
		}

		const supportsAllowedFunctionNames = apiConfiguration?.apiProvider === "gemini"

		const toolsResult = await buildNativeToolsArrayWithRestrictions({
			provider,
			cwd: h.cwd,
			mode,
			customModes: state?.customModes,
			experiments: state?.experiments,
			apiConfiguration,
			disabledTools: state?.disabledTools,
			enableWebSearch: state?.enableWebSearch,
			modelInfo,
			includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
		})
		allTools = toolsResult.tools
		const allowedFunctionNames = toolsResult.allowedFunctionNames

		if (mode) {
			h.cachedToolDefinitions = { mode, tools: allTools, time: Date.now() }
		}

		const shouldIncludeTools = allTools.length > 0

		h.currentRequestAbortController = new AbortController()
		const abortSignal = h.currentRequestAbortController.signal

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: h.taskId,
			signal: abortSignal,
			suppressPreviousResponseId: h.skipPrevResponseIdOnce,
			...(shouldIncludeTools
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: resolveParallelNativeToolCalls(apiConfiguration),
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		if (shouldIncludeTools) {
			checkToolPromptConsistency(systemPrompt, allTools)
		}

		h._rateLimitAlreadyWaitedForThisRequest = false
		h.skipPrevResponseIdOnce = false

		// Apply proactive rate limiting before the API call
		const providerKey = h.apiConfiguration?.apiProvider ?? "default"
		const waitMs = await TokenBucketRateLimiter.getInstance().wait(providerKey)
		if (waitMs > 0) {
			debugLog(`[TokenBucket] Waited ${waitMs}ms for ${providerKey}`)
		}

		const stream = h.api.createMessage(
			systemPrompt,
			cleanConversationHistory as UnsafeAny as Anthropic.Messages.MessageParam[],
			metadata,
		)
		h.stateMachine.force(TaskState.STREAMING)

		// Wrap with backpressure controller to prevent unbounded buffering
		const controlledStream = new BackpressureController(stream as UnsafeAny as AsyncGenerator<UnsafeAny>, 1000, 250)
		const iterator = controlledStream[Symbol.asyncIterator]()

		abortSignal.addEventListener("abort", () => {
			logger.info("TaskExecutor", `AbortSignal triggered for current request, task ${h.taskId}.${h.instanceId}`)
			h.currentRequestAbortController = undefined
		})

		try {
			h.isWaitingForFirstChunk = true

			const firstChunkPromise = iterator.next()
			const abortPromise = new Promise<never>((_, reject) => {
				if (abortSignal.aborted) {
					reject(new Error("Request cancelled by user"))
				} else {
					abortSignal.addEventListener("abort", () => {
						reject(new Error("Request cancelled by user"))
					})
				}
			})

			const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
			await clearRetryEvents(h.globalStoragePath, h.taskId)
			const firstValue = firstChunk.value
			if ((firstValue as Record<string, UnsafeAny>)?.type === "error") {
				const errMsg =
					(firstValue as Record<string, UnsafeAny>)?.message ||
					(firstValue as Record<string, UnsafeAny>)?.error ||
					"API stream error"
				throw new Error(String(errMsg))
			}
			yield firstValue
			h.isWaitingForFirstChunk = false
		} catch (error: UnsafeAny) {
			yield* handleAttemptApiRequestError({
				host: h,
				error,
				retryAttempt,
				autoApprovalEnabled,
				unattendedRetryEnabled,
				unattendedMaxRetryAttempts,
				retryApiRequest: (nextAttempt?: number, nextOptions?: { skipProviderRateLimit?: boolean }) =>
					this.attemptApiRequest(nextAttempt, nextOptions),
			})
			return
		}
		// Delegate remainder: yield* requires AsyncIterable; reuse same iterator state after first manual next().
		yield* {
			[Symbol.asyncIterator]() {
				return iterator
			},
		}
		h.stateMachine.force(TaskState.COMPLETED)
	}

	private checkSubtaskTokenBudget(): void {
		const h = this.host
		if (!h.parentTask) return
		const parentUsage = h.parentTask.getTokenUsage()
		const myUsage = h.getTokenUsage()
		const modelInfo = h.api.getModel().info
		const contextWindow = modelInfo.contextWindow || 200_000
		const parentRemaining = contextWindow - (parentUsage.contextTokens || 0)
		const myTokens = myUsage.contextTokens || 0
		if (parentRemaining > 0 && myTokens > parentRemaining * 0.8) {
			logger.warn(
				"TaskExecutor",
				`SubTask token usage (${myTokens}) approaching parent's remaining budget (${parentRemaining}) for task ${h.taskId}. ` +
					`Consider completing this subtask soon.`,
			)
		}
	}

	async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		const t = this.host

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		while (stack.length > 0) {
			if (t.taskCompleted) {
				break
			}

			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails
			t._savedMessagesForCurrentRequest = false

			if (t.abort) {
				// Only force ERROR if not already in a terminal state, avoiding
				// the COMPLETED -> ERROR unsafe transition race condition.
				if (t.stateMachine.state !== TaskState.COMPLETED) {
					t.stateMachine.force(TaskState.ERROR)
				}
				throw new TaskAbortedError(t.taskId, t.instanceId)
			}

			if (t.consecutiveMistakeLimit > 0 && t.consecutiveMistakeCount >= t.consecutiveMistakeLimit) {
				const { response, text, images } = await t.ask(
					"mistake_limit_reached",
					i18nT("common:errors.mistake_limit_guidance"),
				)

				if (response === "messageResponse") {
					currentUserContent.push(
						...[
							{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
							...formatResponse.imageBlocks(images),
						],
					)

					await t.say("user_feedback", text, images)
				}

				t.consecutiveMistakeCount = 0
			}

			// Determine API protocol based on provider and model
			const modelId = getModelId(t.apiConfiguration)
			const apiProvider = t.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const requestStartedAt = Date.now()
			const requestProfileId = `${t.taskId}-${requestStartedAt}-${t.apiConversationHistory.length + 1}`
			globalQueryProfiler.start({
				requestId: requestProfileId,
				taskId: t.taskId,
				modelId: modelId ?? "UnsafeAny",
				startedAt: requestStartedAt,
			})

			await t.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
			t._rateLimitAlreadyWaitedForThisRequest = true
			t.setLastGlobalApiRequestTime(performance.now())

			await t.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const provider = t.hostRef.deref()
			const state = provider ? await provider.getState() : undefined

			const showRooIgnoredFiles = state?.showRooIgnoredFiles ?? false
			const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
			const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
			const currentMode = state?.mode ?? defaultModeSlug

			const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
				userContent: currentUserContent,
				cwd: t.cwd,
				fileContextTracker: t.fileContextTracker,
				rooIgnoreController: t.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
				skillsManager: provider?.getSkillsManager(),
				currentMode,
			})

			if (slashCommandMode) {
				const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
				if (targetMode && provider) {
					await provider.handleModeSwitch(slashCommandMode)
				}
			}

			const environmentDetails = await getEnvironmentDetails(t as UnsafeAny, currentIncludeFileDetails)

			const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
				if (block.type === "text" && typeof block.text === "string") {
					const isEnvironmentDetailsBlock =
						block.text.trim().startsWith("<environment_details>") &&
						block.text.trim().endsWith("</environment_details>")
					return !isEnvironmentDetailsBlock
				}
				return true
			})

			const finalUserContent = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			const isEmptyUserContent = currentUserContent.length === 0
			const shouldAddUserMessage =
				((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
			if (shouldAddUserMessage) {
				await t.addToApiConversationHistory({ role: "user", content: finalUserContent })
			}

			const lastApiReqIndex = findLastIndex(t.clineMessages, (m: ClineMessage) => m.say === "api_req_started")

			if (lastApiReqIndex >= 0 && t.clineMessages[lastApiReqIndex]) {
				t.clineMessages[lastApiReqIndex].text = JSON.stringify({
					apiProtocol,
				} satisfies ClineApiReqInfo)
			}

			if (!t._savedMessagesForCurrentRequest) {
				await t.saveClineMessages()
				await t.refreshWebviewState()
			}
			t._savedMessagesForCurrentRequest = true

			try {
				// Reset streaming state for each new API request
				t.currentStreamingContentIndex = 0
				t.currentStreamingDidCheckpoint = false
				t.assistantMessageContent = []
				t.didCompleteReadingStream = false
				t.userMessageContent = []
				t.userMessageContentReady = false
				t.didRejectTool = false
				t.didAlreadyUseTool = false
				t.assistantMessageSavedToHistory = false
				t.didToolFailInCurrentTurn = false
				t.presentAssistantMessageLocked = false
				t.presentAssistantMessageHasPendingUpdates = false
				t.streamingToolCallIndices.clear()
				this.toolCallParser.clearAllStreamingToolCalls()
				this.toolCallParser.clearRawChunkState()

				await t.diffViewProvider.reset()

				t.cachedStreamingModel = t.api.getModel()

				const stream = t.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
				t.isStreaming = true

				const finalizeToolUse: FinalizeToolUseFn = (task, id, finalToolUse) =>
					this.placeFinalizedStreamingToolUse(task, id, finalToolUse)

				const consumptionResult = await consumeApiStream({
					task: t,
					stream,
					toolCallParser: this.toolCallParser,
					placeFinalizedStreamingToolUse: finalizeToolUse,
					requestProfileId,
					lastApiReqIndex,
					requestStartedAt,
					retryAttempt: currentItem.retryAttempt ?? 0,
					currentUserContent,
					stack,
				})

				if (consumptionResult.action === "continue") continue
				if (consumptionResult.action === "break") break

				const finalizeResult = await finalizeStreamResponse({
					task: t,
					toolCallParser: this.toolCallParser,
					placeFinalizedStreamingToolUse: finalizeToolUse,
					consumptionResult,
					requestProfileId,
					lastApiReqIndex,
					retryAttempt: currentItem.retryAttempt ?? 0,
					currentUserContent,
					stack,
				})

				if (finalizeResult.action === "continue") continue
				if (finalizeResult.action === "break") break

				return false
			} catch (error) {
				const h = this.host
				const errMsg = getErrorMessage(error)
				logger.error(
					"TaskExecutor",
					`Unhandled error in request loop for task ${h.taskId}:`,
					errMsg,
					error instanceof Error ? error.stack : "",
				)
				TelemetryService.reportError(error, TelemetryEventName.TASK_LIFECYCLE_ERROR)
				if (h.presentAssistantMessageLocked) {
					logger.warn(
						"TaskExecutor",
						`Force-releasing stuck presentAssistantMessageLocked for task ${h.taskId}`,
					)
					h.presentAssistantMessageLocked = false
				}
				if (!h.abort) {
					try {
						await h.say("error", `Task ended unexpectedly: ${errMsg}`)
					} catch (sayError) {
						logger.warn("TaskExecutor", "Failed to notify user about task error", sayError)
					}
				}
				return true
			}
		}

		return false
	}
}
