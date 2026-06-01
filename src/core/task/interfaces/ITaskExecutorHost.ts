/**
 * TaskExecutorHost — Decomposed interface for the TaskExecutor host contract.
 *
 * This file extracts the monolithic `TaskExecutorHost` interface into
 * focused sub-interfaces for better testability and maintainability.
 * Task.ts implements the combined `TaskExecutorHost` type.
 */
import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"
import type {
	ClineMessage,
	ClineSay,
	ClineAsk,
	ContextCondense,
	ContextTruncation,
	ProviderSettings,
	ToolProgressStatus,
	TokenUsage,
} from "@njust-ai/types"

import type { ApiHandler } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import type { AssistantMessageContent } from "../../assistant-message/types"
import type { ApiMessage } from "../../task-persistence"
import type { SystemPromptParts } from "../../prompts/system"
import type { FileContextTracker } from "../../context-tracking/FileContextTracker"
import type { PersistentRetryManager } from "../PersistentRetry"
import type { TaskState } from "../TaskStateMachine"
import type { ITaskHost } from "./ITaskHost"
import type { ITaskDiffViewProvider } from "./ITaskDiffViewProvider"

// ── Sub-interfaces ────────────────────────────────────────────────────────

/** Identity and basic mutable state. */
export interface TaskExecutorIdentityHost {
	readonly taskId: string
	readonly instanceId: string
	readonly globalStoragePath: string
	readonly cwd: string
	abort: boolean
	abortReason?: string
	taskCompleted: boolean
	isPaused: boolean
	isStreaming: boolean
	isWaitingForFirstChunk: boolean
}

/** API configuration, conversation history, and streaming content state. */
export interface TaskExecutorApiHost {
	apiConfiguration: ProviderSettings
	api: ApiHandler
	apiConversationHistory: ApiMessage[]
	clineMessages: ClineMessage[]
	userMessageContent: Anthropic.Messages.ContentBlockParam[]
	assistantMessageContent: AssistantMessageContent[]
	assistantMessageSavedToHistory: boolean
	userMessageContentReady: boolean
	currentStreamingContentIndex: number
	didCompleteReadingStream: boolean
}

/** State machine, sub-delegates, and service references. */
export interface TaskExecutorDelegatesHost {
	stateMachine: { force(state: TaskState): void; readonly state: TaskState }
	hostRef: WeakRef<ITaskHost>
	requestBuilder: {
		prefetchSystemPromptData(): void
		getSystemPromptParts(): Promise<SystemPromptParts>
		getSystemPrompt(): Promise<string>
		condenseContext(): Promise<void>
		inheritCacheFromParent(parent: UnsafeAny): void
	}
	streamProcessor: {
		maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void>
		backoffAndAnnounce(retryAttempt: number, error: UnsafeAny): Promise<void>
		buildCleanConversationHistory(messages: ApiMessage[]): UnsafeAny[]
		getCurrentProfileId(state: UnsafeAny): string
		handleContextWindowExceededError(): Promise<void>
		getFilesReadByRooSafely(context: string): Promise<string[] | undefined>
	}
	errorRecovery: {
		handleApiError(error: UnsafeAny, retryAttempt: number): Promise<{ action: string; nextAttempt: number }>
		shouldBypassCondense(): boolean
		recordCompactFailure(error: UnsafeAny): Promise<void>
		resetCompactFailure(): void
	}
	autoApprovalHandler: {
		checkAutoApprovalLimits(
			state: UnsafeAny,
			messages: ClineMessage[],
			askFn: (type: ClineAsk, data?: string) => Promise<{ response: string; text?: string; images?: string[] }>,
		): Promise<{ shouldProceed: boolean }>
	}
	tokenGrowthTracker: {
		addSample(tokens: number): void
		getSnapshot(): { predictedNextTokens?: number } | undefined
	}
	persistentRetryHandler: PersistentRetryManager | undefined
	parentTask: { getTokenUsage(): TokenUsage } | undefined
	rooIgnoreController: { dispose(): void } | undefined
	toolExecution: {
		dispose(): void
		streamingExecutor: { shouldEagerExecute(task: UnsafeAny, block: UnsafeAny): string | null }
	}
	compactFailureCount: number
}

/** Token window tracking and tool caching. */
export interface TaskExecutorTokenHost {
	requestCacheReadWindow: number[]
	requestInputTokensWindow: number[]
	cachedToolDefinitions: { mode: string; tools: OpenAI.Chat.ChatCompletionTool[]; time: number } | undefined
}

/** Request lifecycle control and mistake tracking. */
export interface TaskExecutorRequestHost {
	currentRequestAbortController: AbortController | undefined
	skipPrevResponseIdOnce: boolean
	consecutiveMistakeCount: number
	consecutiveMistakeLimit: number
	didEditFile: boolean
	_rateLimitAlreadyWaitedForThisRequest?: boolean
}

/** Streaming presentation state and lifecycle flags. */
export interface TaskExecutorStreamHost {
	abandoned: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	didToolFailInCurrentTurn: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	consecutiveNoToolUseCount: number
	consecutiveNoAssistantMessagesCount: number
	streamingToolCallIndices: Map<string, number>
	cachedStreamingModel?: ReturnType<ApiHandler["getModel"]>
	notifier?: { postMessageToWebview(message: UnsafeAny): Promise<void> }
	didFinishAbortingStream: boolean
	currentStreamingDidCheckpoint: boolean
	_savedMessagesForCurrentRequest?: boolean
}

/** Diff view and file context tracking. */
export interface TaskExecutorServicesHost {
	diffViewProvider: ITaskDiffViewProvider
	fileContextTracker: FileContextTracker
}

/** Communication methods: say, ask, history management. */
export interface TaskExecutorMessagingHost {
	say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, UnsafeAny>,
		progressStatus?: ToolProgressStatus,
		options?: { isNonInteractive?: boolean },
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined>

	ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: string; text?: string; images?: string[] }>

	addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<void>
	overwriteApiConversationHistory(newHistory: ApiMessage[]): Promise<void>
	pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean
	cancelCurrentRequest(): void
}

/** Persistence, events, and control methods. */
export interface TaskExecutorControlHost {
	getTokenUsage(): TokenUsage
	combineMessages(messages: ClineMessage[]): ClineMessage[]
	emit(event: string, ...args: UnsafeAny[]): boolean

	setLastGlobalApiRequestTime(time: number): void
	getLastGlobalApiRequestTime(): number

	saveClineMessages(): Promise<boolean>
	refreshWebviewState(): Promise<void>
	updateClineMessage(message: ClineMessage): Promise<void>

	abortTask(isAbandoned?: boolean): Promise<void>
	backoffAndAnnounce(retryAttempt: number, error: UnsafeAny): Promise<void>
	maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void>
	attemptApiRequest(retryAttempt: number, options?: { skipProviderRateLimit?: boolean }): ApiStream
	presentAssistantMessage(): Promise<void>

	getTaskMode(): string | undefined
}

// ── Combined interface ────────────────────────────────────────────────────

/**
 * Full host contract for TaskExecutor.
 * Task.ts implements this shape; TaskExecutor.ts only imports this interface.
 */
export type TaskExecutorHost = TaskExecutorIdentityHost &
	TaskExecutorApiHost &
	TaskExecutorDelegatesHost &
	TaskExecutorTokenHost &
	TaskExecutorRequestHost &
	TaskExecutorStreamHost &
	TaskExecutorServicesHost &
	TaskExecutorMessagingHost &
	TaskExecutorControlHost
