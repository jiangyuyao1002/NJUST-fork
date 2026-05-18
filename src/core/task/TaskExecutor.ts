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
import pWaitFor from "p-wait-for"
import { z } from "zod"

import type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"
export type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"

import type {
	ClineMessage,
	ClineApiReqInfo,
	ClineApiReqCancelReason,
	ContextCondense,
	ContextTruncation,
} from "@njust-ai-cj/types"
import {
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	getApiProtocol,
	getModelId,
	isRetiredProvider,
} from "@njust-ai-cj/types"

import type { ApiHandlerCreateMessageMetadata } from "../../api"
import { resolveParallelNativeToolCalls } from "../../shared/parallelToolCalls"
import { type ApiStream, GroundingSource } from "../../api/transform/stream"
import { checkToolPromptConsistency } from "../prompts/toolPromptConsistency"
import { markUserContentReadyIfDrained } from "../assistant-message/streamState"
import { isAnyToolUse, isToolUseBlock, type TypedBlock } from "../assistant-message/types"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { ApiMessage } from "../task-persistence"
import { getModelMaxOutputTokens } from "../../shared/api"
import { findLastIndex } from "../../shared/array"
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { globalPromptCacheBreakDetector } from "../prompts/promptCacheBreakDetection"
import { globalQueryProfiler } from "../../utils/queryProfiler"
import { globalCacheMetrics } from "../../utils/cacheMetrics"
import { sanitizeToolUseId } from "../../utils/tool-id"
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
import { TokenBucketRateLimiter } from "../../services/rate-limiter/TokenBucketRateLimiter"
import { BackpressureController } from "../stream/BackpressureController"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { finalizePendingStreamingToolCalls, processTaskStreamChunk } from "./TaskStreamChunkProcessor"
import { handleAttemptApiRequestError, handleEmptyAssistantResponse, handleMidStreamFailure } from "./TaskRetryHandler"
import { clineApiReqInfoSchema } from "@njust-ai-cj/types"

const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000

/**
 * Maximum time (ms) to wait for presentAssistantMessage to set
 * userMessageContentReady.  If a tool handler hangs or fails to push
 * a tool_result, this prevents the executor from blocking forever.
 * Set to 0 to disable (infinite wait, legacy behaviour).
 */
const USER_MESSAGE_CONTENT_READY_TIMEOUT_MS = 30_000

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

		if (!options.skipProviderRateLimit) {
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
					compactFailures: h.compactFailures,
					isSubAgent: h.parentTask !== undefined,
				})
				h.compactFailures = truncateResult.compactFailures ?? 0
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
			throw new Error("Auto-approval limit reached and user did not approve continuation")
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

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: h.taskId,
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

		h.currentRequestAbortController = new AbortController()
		const abortSignal = h.currentRequestAbortController.signal
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

		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		while (stack.length > 0) {
			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (t.abort) {
				t.stateMachine.force(TaskState.ERROR)
				throw new Error(`[NJUST_AI_CJ#recursivelyMakeClineRequests] task ${t.taskId}.${t.instanceId} aborted`)
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

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

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

			// Respect user-configured provider rate limiting BEFORE we emit api_req_started.
			// This prevents the UI from showing an "API Request..." spinner while we are
			// intentionally waiting due to the rate limit slider.
			//
			// NOTE: We also set Task.lastGlobalApiRequestTime here to reserve this slot
			// before we build environment details (which can take time).
			// This ensures subsequent requests (including subtasks) still honour the
			// provider rate-limit window.
			await t.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
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

			// Switch mode if specified in a slash command's frontmatter
			if (slashCommandMode) {
				const provider = t.hostRef.deref()
				if (provider) {
					const state = await provider.getState()
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.handleModeSwitch(slashCommandMode)
					}
				}
			}

			const environmentDetails = await getEnvironmentDetails(t as UnsafeAny, currentIncludeFileDetails)

			// Remove any existing environment_details blocks before adding fresh ones.
			// This prevents duplicate environment details when resuming tasks,
			// where the old user message content may already contain environment details from the previous session.
			// We check for both opening and closing tags to ensure we're matching complete environment detail blocks,
			// not just mentions of the tag in regular content.
			const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
				if (block.type === "text" && typeof block.text === "string") {
					// Check if this text block is a complete environment_details block
					// by verifying it starts with the opening tag and ends with the closing tag
					const isEnvironmentDetailsBlock =
						block.text.trim().startsWith("<environment_details>") &&
						block.text.trim().endsWith("</environment_details>")
					return !isEnvironmentDetailsBlock
				}
				return true
			})

			// Add environment details as its own text block, separate from tool
			// results.
			const finalUserContent = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			// Only add user message to conversation history if:
			// 1. This is the first attempt (retryAttempt === 0), AND
			// 2. The original userContent was not empty (empty signals delegation resume where
			//    the user message with tool_result and env details is already in history), OR
			// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
			// This prevents consecutive user messages while allowing re-add when needed
			const isEmptyUserContent = currentUserContent.length === 0
			const shouldAddUserMessage =
				((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
			if (shouldAddUserMessage) {
				await t.addToApiConversationHistory({ role: "user", content: finalUserContent })
			}

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(t.clineMessages, (m: ClineMessage) => m.say === "api_req_started")

			if (lastApiReqIndex >= 0 && t.clineMessages[lastApiReqIndex]) {
				t.clineMessages[lastApiReqIndex].text = JSON.stringify({
					apiProtocol,
				} satisfies ClineApiReqInfo)
			}

			await t.saveClineMessages()
			await t.refreshWebviewState()

			let assistantMessage = ""
			let reasoningMessage = ""
			const pendingGroundingSources: GroundingSource[] = []
			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let totalCost: number | undefined

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !t.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = clineApiReqInfoSchema.parse(
						JSON.parse(t.clineMessages[lastApiReqIndex].text || "{}"),
					)

					// Calculate total tokens and cost using provider-aware function
					const modelId = getModelId(t.apiConfiguration)
					const apiProvider = t.apiConfiguration.apiProvider
					const apiProtocol = getApiProtocol(
						apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
						modelId,
					)

					const costResult =
						apiProtocol === "anthropic"
							? calculateApiCostAnthropic(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)
							: calculateApiCostOpenAI(
									streamModelInfo,
									inputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)

					t.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: costResult.totalInputTokens,
						tokensOut: costResult.totalOutputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						cost: totalCost ?? costResult.totalCost,
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (t.diffViewProvider.isEditing) {
						await t.diffViewProvider.revertChanges() // closes diff view
					}

					// if last message is a partial we need to update and save it
					const lastMessage = t.clineMessages.at(-1)

					if (lastMessage?.partial) {
						// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
						lastMessage.partial = false
						// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					}

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await t.saveClineMessages()

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					t.didFinishAbortingStream = true
				}

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
				// Reset tool failure flag for each new assistant turn - this ensures that tool failures
				// only prevent attempt_completion within the same assistant message, not across turns
				// (e.g., if a tool fails, then user sends a message saying "just complete anyway")
				t.didToolFailInCurrentTurn = false
				t.presentAssistantMessageLocked = false
				t.presentAssistantMessageHasPendingUpdates = false
				// No legacy text-stream tool parser.
				t.streamingToolCallIndices.clear()
				// Clear any leftover streaming tool call state from previous interrupted streams
				this.toolCallParser.clearAllStreamingToolCalls()
				this.toolCallParser.clearRawChunkState()

				await t.diffViewProvider.reset()

				// Cache model info once per API request to avoid repeated calls during streaming
				// This is especially important for tools and background usage collection
				t.cachedStreamingModel = t.api.getModel()
				const streamModelInfo = t.cachedStreamingModel.info
				const cachedModelId = t.cachedStreamingModel.id

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = t.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
				t.isStreaming = true

				try {
					const iterator = stream[Symbol.asyncIterator]()

					// Helper to race iterator.next() with abort signal
					const nextChunkWithAbort = async () => {
						const nextPromise = iterator.next()

						// If we have an abort controller, race it with the next chunk
						if (t.currentRequestAbortController) {
							const signal = t.currentRequestAbortController!.signal
							let onAbort: (() => void) | undefined
							const abortPromise = new Promise<never>((_, reject) => {
								if (signal.aborted) {
									reject(new Error("Request cancelled by user"))
									return
								}
								onAbort = () => reject(new Error("Request cancelled by user"))
								signal.addEventListener("abort", onAbort, { once: true })
							})
							try {
								return await Promise.race([nextPromise, abortPromise])
							} finally {
								if (onAbort) signal.removeEventListener("abort", onAbort)
							}
						}

						// No abort controller, just return the next chunk normally
						return await nextPromise
					}

					let item = await nextChunkWithAbort()
					while (!item.done) {
						const chunk = item.value
						item = await nextChunkWithAbort()
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							continue
						}

						await processTaskStreamChunk({
							task: t,
							chunk,
							toolCallParser: this.toolCallParser,
							requestProfileId,
							pendingGroundingSources,
							finalizeToolUse: (task, id, finalToolUse) =>
								this.placeFinalizedStreamingToolUse(task, id, finalToolUse),
							appendReasoningText: (text) => {
								reasoningMessage += text
								return reasoningMessage
							},
							appendAssistantText: (text) => {
								assistantMessage += text
								return assistantMessage
							},
							addUsage: (usageChunk) => {
								inputTokens += usageChunk.inputTokens
								outputTokens += usageChunk.outputTokens
								cacheWriteTokens += usageChunk.cacheWriteTokens ?? 0
								cacheReadTokens += usageChunk.cacheReadTokens ?? 0
								totalCost = usageChunk.totalCost
							},
						})
						if (t.abort) {
							logger.info(
								"TaskExecutor",
								`Aborting stream for task ${t.taskId}, abandoned = ${t.abandoned}`,
							)

							if (!t.abandoned) {
								// Only need to gracefully abort if this instance
								// isn't abandoned (sometimes OpenRouter stream
								// hangs, in which case this would affect future
								// instances of Cline).
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (t.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// t.userMessageContentReady = true
							break
						}

						if (t.didAlreadyUseTool) {
							assistantMessage +=
								"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
							break
						}
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = performance.now()
						const modelId = getModelId(t.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// Helper function to capture telemetry and update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								// Update the shared variables atomically
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								// Update the API request message with the latest usage data
								updateApiReqMsg()
								await t.saveClineMessages()

								// Update the specific message in the webview
								const apiReqMessage = t.clineMessages[messageIndex]
								if (apiReqMessage) {
									await t.updateClineMessage(apiReqMessage)
								}

								// Capture telemetry with provider-aware cost calculation
								const modelId = getModelId(t.apiConfiguration)
								const apiProvider = t.apiConfiguration.apiProvider
								const apiProtocol = getApiProtocol(
									apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
									modelId,
								)

								// Use the appropriate cost function based on the API protocol
								const _costResult =
									apiProtocol === "anthropic"
										? calculateApiCostAnthropic(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)
										: calculateApiCostOpenAI(
												streamModelInfo,
												tokens.input,
												tokens.output,
												tokens.cacheWrite,
												tokens.cacheRead,
											)

								globalCacheMetrics.record({
									timestamp: Date.now(),
									inputTokens: tokens.input,
									cacheCreationInputTokens: tokens.cacheWrite,
									cacheReadInputTokens: tokens.cacheRead,
									outputTokens: tokens.output,
									model: cachedModelId,
								})
								t.requestCacheReadWindow.push(tokens.cacheRead)
								if (t.requestCacheReadWindow.length > 5) {
									t.requestCacheReadWindow.shift()
								}
								t.requestInputTokensWindow.push(tokens.input)
								if (t.requestInputTokensWindow.length > 5) {
									t.requestInputTokensWindow.shift()
								}
								const cacheSummary = globalCacheMetrics.getSummary()

								const latencyMs = Date.now() - requestStartedAt
								logger.info(
									"TaskExecutor",
									`Task Metrics: task=${t.taskId} mode=${await t.getTaskMode()} latencyMs=${latencyMs} input=${tokens.input} output=${tokens.output} cacheCreate=${tokens.cacheWrite} cacheRead=${tokens.cacheRead} contextTokens=${t.getTokenUsage().contextTokens ?? 0} cacheHitRate=${cacheSummary.cacheHitRate.toFixed(3)} estSavings=${(cacheSummary.estimatedSavingsPercent * 100).toFixed(1)}% requests=${cacheSummary.totalRequests}`,
								)
								const runtimeTokenUsage = t.getTokenUsage()
								const runtimeContextTokens = runtimeTokenUsage.contextTokens ?? 0
								const runtimeModel = t.api.getModel().info
								const runtimeContextWindow = runtimeModel?.contextWindow ?? 0
								const runtimeContextPercent =
									runtimeContextWindow > 0 ? (runtimeContextTokens / runtimeContextWindow) * 100 : 0
								const runtimeState = await t.hostRef.deref()?.getState()
								const runtimeAutoCondenseContext = runtimeState?.autoCondenseContext ?? true
								const runtimeAutoCondenseContextPercent =
									runtimeState?.autoCondenseContextPercent ?? DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT
								const runtimeProfileThresholds = runtimeState?.profileThresholds ?? {}
								const runtimeCurrentProfileId = runtimeState?.currentApiConfigName ?? "default"
								const compactLikelyTriggered = willManageContext({
									totalTokens: runtimeContextTokens,
									contextWindow: runtimeContextWindow,
									maxTokens: runtimeModel?.maxTokens,
									autoCondenseContext: runtimeAutoCondenseContext,
									autoCondenseContextPercent: runtimeAutoCondenseContextPercent,
									profileThresholds: runtimeProfileThresholds,
									currentProfileId: runtimeCurrentProfileId,
									lastMessageTokens: 0,
								})
								await t.notifier?.postMessageToWebview({
									type: "taskMetrics",
									taskMetrics: {
										taskId: t.taskId,
										latencyMs,
										cacheHitRate: cacheSummary.cacheHitRate,
										estimatedSavingsPercent: cacheSummary.estimatedSavingsPercent * 100,
										cacheReadInputTokens: tokens.cacheRead,
										cacheCreationInputTokens: tokens.cacheWrite,
										inputTokens: tokens.input,
										outputTokens: tokens.output,
										contextTokens: runtimeContextTokens,
										contextPercent: runtimeContextPercent,
										compactLikelyTriggered,
										cacheBreaksTotal: globalPromptCacheBreakDetector.getTotalBreaks(),
										cacheBreaksBySource: globalPromptCacheBreakDetector.getBreaksBySource(),
									},
								})
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (performance.now() - startTime > timeoutMs) {
									logger.warn(
										"TaskExecutor",
										`Background Usage Collection timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								logger.warn(
									"TaskExecutor",
									`Background Usage Collection: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
							}
						} catch (error) {
							logger.error("TaskExecutor", "Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						logger.error("TaskExecutor", "Background usage collection failed:", error)
					})
				} catch (error) {
					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to t.abort).
					if (!t.abandoned) {
						const rawErrorMessage = getErrorMessage(error)
						const streamingFailedMessage = t.abort
							? undefined
							: `${i18nT("common:interruption.streamTerminatedByProvider")}: ${rawErrorMessage}`

						const retryAction = await handleMidStreamFailure({
							task: t,
							error,
							currentRetryAttempt: currentItem.retryAttempt ?? 0,
							currentUserContent,
							stack,
							streamingFailedMessage,
							abortStream,
						})

						if (retryAction === "continue") {
							continue
						}
						if (retryAction === "break") {
							break
						}
					}
				} finally {
					t.isStreaming = false
					const profile = globalQueryProfiler.finish(requestProfileId, {
						aborted: t.abort || t.abandoned,
					})
					if (profile) {
						logger.info(
							"TaskExecutor",
							`Query Profiler: task=${profile.taskId} model=${profile.modelId} ttftMs=${profile.ttftMs ?? -1} e2eMs=${profile.e2eMs ?? -1} aborted=${profile.aborted}`,
						)
					}
					// Clean up the abort controller when streaming completes
					t.currentRequestAbortController = undefined
				}

				// Need to call here in case the stream was aborted.
				if (t.abort || t.abandoned) {
					t.stateMachine.force(TaskState.ERROR)
					throw new Error(
						`[NJUST_AI_CJ#recursivelyMakeClineRequests] task ${t.taskId}.${t.instanceId} aborted`,
					)
				}

				t.didCompleteReadingStream = true

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)

				await finalizePendingStreamingToolCalls({
					task: t,
					toolCallParser: this.toolCallParser,
					finalizeToolUse: (task, id, finalToolUse) =>
						this.placeFinalizedStreamingToolUse(task, id, finalToolUse),
				})
				// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
				// Tools finalized above are already presented, so we only want blocks still partial after finalization.
				const partialBlocks = t.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// t.assistantMessageContent.forEach((e) => (e.partial = false))

				// No legacy streaming parser to finalize.

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it exists
				// We can't use say() here because the reasoning message may not be the last message
				// (other messages like text blocks or tool uses may have been added after it during streaming)
				if (reasoningMessage) {
					const lastReasoningIndex = findLastIndex(
						t.clineMessages,
						(m: ClineMessage) => m.type === "say" && m.say === "reasoning",
					)

					if (lastReasoningIndex !== -1 && t.clineMessages[lastReasoningIndex]!.partial) {
						t.clineMessages[lastReasoningIndex]!.partial = false
						await t.updateClineMessage(t.clineMessages[lastReasoningIndex]!)
					}
				}

				await t.saveClineMessages()
				await t.refreshWebviewState()

				// No legacy text-stream tool parser state to reset.

				// CRITICAL: Save assistant message to API history BEFORE executing tools.
				// This ensures that when new_task triggers delegation and calls flushPendingToolResultsToHistory(),
				// the assistant message is already in history. Otherwise, tool_result blocks would appear
				// BEFORE their corresponding tool_use blocks, causing API errors.

				// Check if we have any content to process (text or tool uses)
				const hasTextContent = assistantMessage.length > 0

				const hasToolUses = t.assistantMessageContent.some(isAnyToolUse)

				if (hasTextContent || hasToolUses) {
					// Reset counter when we get a successful response with content
					t.consecutiveNoAssistantMessagesCount = 0
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map(
							(source: GroundingSource, i: number) => `[${i + 1}](${source.url})`,
						)
						const sourcesText = `${i18nT("common:gemini.sources")} ${citationLinks.join(", ")}`

						await t.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					// Build the assistant message content array
					const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

					// Add text content if present
					if (assistantMessage) {
						assistantContent.push({
							type: "text" as const,
							text: assistantMessage,
						})
					}

					// Add tool_use blocks with their IDs for native protocol
					// This handles both regular ToolUse and McpToolUse types
					// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
					// Duplicate tool_use IDs cause Anthropic API 400 errors:
					// "tool_use ids must be unique"
					const seenToolUseIds = new Set<string>()
					const toolUseBlocks = t.assistantMessageContent.filter(isAnyToolUse)
					for (const block of toolUseBlocks) {
						if (block.type === "mcp_tool_use") {
							// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
							// The arguments are the raw tool arguments (matching the simplified schema)
							const mcpBlock = block as import("../../shared/tools").McpToolUse
							if (mcpBlock.id) {
								const sanitizedId = sanitizeToolUseId(mcpBlock.id)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									logger.warn(
										"TaskExecutor",
										`Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name}) on task ${t.taskId}`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: mcpBlock.name, // Original dynamic name
									input: mcpBlock.arguments, // Direct tool arguments
								})
							}
						} else {
							// Regular ToolUse
							const toolUse = block as import("../../shared/tools").ToolUse
							const toolCallId = toolUse.id
							if (toolCallId) {
								const sanitizedId = sanitizeToolUseId(toolCallId)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									logger.warn(
										"TaskExecutor",
										`Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name}) on task ${t.taskId}`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								// nativeArgs is already in the correct API format for all tools
								const input = toolUse.nativeArgs || toolUse.params

								// Use originalName (compatibility alias) if present for API history consistency.
								// The history should match the tool name the model was shown.
								const toolNameForHistory = toolUse.originalName ?? toolUse.name

								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: toolNameForHistory,
									input,
								})
							}
						}
					}

					// Enforce new_task isolation: if new_task is called alongside other tools,
					// truncate any tools that come after it and inject error tool_results.
					// This prevents orphaned tools when delegation disposes the parent task.
					const newTaskIndex = assistantContent.findIndex(
						(block) => block.type === "tool_use" && block.name === "new_task",
					)

					if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
						// new_task found but not last - truncate subsequent tools
						const truncatedTools = assistantContent.slice(newTaskIndex + 1)
						assistantContent.length = newTaskIndex + 1 // Truncate API history array

						// ALSO truncate the execution array (assistantMessageContent) to prevent
						// tools after new_task from being executed by presentAssistantMessage().
						// Find new_task index in assistantMessageContent (may differ from assistantContent
						// due to text blocks being structured differently).
						const executionNewTaskIndex = t.assistantMessageContent.findIndex(
							(block) => isToolUseBlock(block) && block.name === "new_task",
						)
						if (executionNewTaskIndex !== -1) {
							t.assistantMessageContent.length = executionNewTaskIndex + 1
						}

						// Pre-inject error tool_results for truncated tools
						for (const tool of truncatedTools) {
							if (tool.type === "tool_use" && (tool as Anthropic.ToolUseBlockParam).id) {
								t.pushToolResultToUserContent({
									type: "tool_result",
									tool_use_id: (tool as Anthropic.ToolUseBlockParam).id,
									content:
										"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
									is_error: true,
								})
							}
						}
					}

					// Save assistant message BEFORE executing tools
					// This is critical for new_task: when it triggers delegation, flushPendingToolResultsToHistory()
					// will save the user message with tool_results. The assistant message must already be in history
					// so that tool_result blocks appear AFTER their corresponding tool_use blocks.
					await t.addToApiConversationHistory(
						{ role: "assistant", content: assistantContent },
						reasoningMessage || undefined,
					)
					t.assistantMessageSavedToHistory = true
				}

				// Present any partial blocks that were just completed.
				// Tool calls are typically presented during streaming via tool_call_partial events,
				// but we still present here if any partial blocks remain (e.g., malformed streams).
				// NOTE: This MUST happen AFTER saving the assistant message to API history.
				// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory().
				// If the assistant message isn't saved yet, tool_results would appear before tool_use blocks.
				if (partialBlocks.length > 0) {
					// If there is content to update then it will complete and
					// update `t.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request.
					void t.presentAssistantMessage().catch((error) => {
						logger.error("presentAssistantMessage failed", error)
					})
				}

				if (hasTextContent || hasToolUses) {
					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = t.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (t.currentStreamingContentIndex >= completeBlocks.length) {
					// 	t.userMessageContentReady = true
					// }

					const waitStartMs = performance.now()
					debugLog(
						`[TaskExecutor][${requestProfileId}] pWaitFor userMessageContentReady – start (contentIndex=${t.currentStreamingContentIndex}, blocks=${t.assistantMessageContent.length})`,
					)

					try {
						await pWaitFor(() => t.userMessageContentReady, {
							...(USER_MESSAGE_CONTENT_READY_TIMEOUT_MS > 0 && {
								timeout: USER_MESSAGE_CONTENT_READY_TIMEOUT_MS,
							}),
						})
					} catch (_timeoutErr) {
						// Timeout: inject error tool_results for any tool_use blocks
						// that never received a result, then force-unblock.
						const pendingToolBlocks = t.assistantMessageContent.filter(
							(b: UnsafeAny) =>
								(b.type === "tool_use" || b.type === "mcp_tool_use") &&
								b.id &&
								!t.userMessageContent.some(
									(r: UnsafeAny) =>
										r.type === "tool_result" && r.tool_use_id === sanitizeToolUseId(b.id),
								),
						)

						logger.error(
							"TaskExecutor",
							`userMessageContentReady timed out after ${USER_MESSAGE_CONTENT_READY_TIMEOUT_MS}ms ` +
								`(taskId=${t.taskId}, instance=${t.instanceId}, contentIndex=${t.currentStreamingContentIndex}, ` +
								`blocks=${t.assistantMessageContent.length}, pendingTools=${pendingToolBlocks.length})`,
						)

						for (const block of pendingToolBlocks) {
							const toolUseId = (block as ToolUse | McpToolUse).id ?? ""
							t.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolUseId),
								content: formatResponse.toolError(
									"Tool execution timed out — the handler did not return a result within the allowed window.",
								),
								is_error: true,
							})
						}

						markUserContentReadyIfDrained(t as UnsafeAny)
						t.userMessageContentReady = true
					}

					debugLog(
						`[TaskExecutor][${requestProfileId}] pWaitFor userMessageContentReady – done (${(performance.now() - waitStartMs).toFixed(0)}ms)`,
					)

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					const didToolUse = t.assistantMessageContent.some(isAnyToolUse)

					if (!didToolUse) {
						// Increment consecutive no-tool-use counter
						t.consecutiveNoToolUseCount++

						if (t.consecutiveNoToolUseCount >= 3) {
							// Severe throttling: force the model to stop retrying
							await t.say("error", "MODEL_NO_TOOLS_USED")
							t.consecutiveMistakeCount += 2
							t.userMessageContent.push({
								type: "text",
								text: formatResponse.toolRetryThrottled(),
							})
							t.consecutiveNoToolUseCount = 0
						} else if (t.consecutiveNoToolUseCount >= 2) {
							await t.say("error", "MODEL_NO_TOOLS_USED")
							t.consecutiveMistakeCount++

							// Check if the previous tool result was an interruption
							const lastUserMsg = t.apiConversationHistory
								.filter((m: UnsafeAny) => m.role === "user")
								.pop()
							const wasInterrupted =
								lastUserMsg &&
								Array.isArray(lastUserMsg.content) &&
								lastUserMsg.content.some(
									(block) =>
										(block as TypedBlock).type === "tool_result" &&
										typeof (block as TypedBlock).content === "string" &&
										((block as TypedBlock).content as string).includes("interrupted"),
								)

							t.userMessageContent.push({
								type: "text",
								text: wasInterrupted
									? formatResponse.noToolsUsedWithInterruptHint()
									: formatResponse.noToolsUsed(),
							})
						} else {
							// First failure: silent retry
							t.userMessageContent.push({
								type: "text",
								text: formatResponse.noToolsUsed(),
							})
						}
					} else {
						// Reset counter when tools are used successfully
						t.consecutiveNoToolUseCount = 0
					}

					// Push to stack if there's content OR if we're paused waiting for a subtask.
					// When paused, we push an empty item so the loop continues to the pause check.
					if (t.userMessageContent.length > 0 || t.isPaused) {
						stack.push({
							userContent: [...t.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))
					}

					continue
				} else {
					const emptyResponseAction = await handleEmptyAssistantResponse({
						task: t,
						currentRetryAttempt: currentItem.retryAttempt ?? 0,
						currentUserContent,
						stack,
					})

					if (emptyResponseAction === "continue") {
						continue
					}
					if (emptyResponseAction === "break") {
						break
					}
				}
				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// A tool execution or presentAssistantMessage threw an unhandled
				const h = this.host
				// exception. Log it, notify the user, and end the task gracefully.
				const errMsg = getErrorMessage(error)
				logger.error(
					"TaskExecutor",
					`Unhandled error in request loop for task ${h.taskId}:`,
					errMsg,
					error instanceof Error ? error.stack : "",
				)
				// Release the presentAssistantMessage lock if it was held.
				// presentAssistantMessageLocked may be stuck true if the exception
				// escaped the while loop without reaching the finally block.
				if (h.presentAssistantMessageLocked) {
					logger.warn(
						"TaskExecutor",
						`Force-releasing stuck presentAssistantMessageLocked for task ${h.taskId}`,
					)
					h.presentAssistantMessageLocked = false
				}
				// Notify the user through the UI
				try {
					await h.say("error", `Task ended unexpectedly: ${errMsg}`)
				} catch (sayError) {
					// Best-effort notification
					logger.warn("TaskExecutor", "Failed to notify user about task error", sayError)
				}
				return true // End the task loop
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}
}
