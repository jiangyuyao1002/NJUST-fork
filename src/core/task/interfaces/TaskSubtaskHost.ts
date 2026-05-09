/**
 * TaskSubtaskHost — Interface for TaskSubtaskHandler dependency injection.
 *
 * Defines the minimal surface TaskSubtaskHandler needs from its owning Task.
 * Extracted from Task.ts as part of Phase 1 decomposition.
 */
import type { ClineMessage } from "@njust-ai-cj/types"
import type { ApiMessage } from "../../task-persistence"
import type { IsolationLevel } from "../SubTaskOptions"
import type { ForkedContextConfig, CacheSafeParams } from "../SubTaskOptions"

export interface TaskSubtaskHost {
	// Identity
	readonly taskId: string

	// Mutable state for resumeAfterDelegation
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage
	abort: boolean
	abandoned: boolean
	abortReason?: string
	didFinishAbortingStream: boolean
	isStreaming: boolean
	isWaitingForFirstChunk: boolean
	skipPrevResponseIdOnce: boolean
	isInitialized: boolean

	// API conversation history
	apiConversationHistory: ApiMessage[]

	// Provider reference
	hostRef: { deref(): any }

	// Task methods
	getSavedApiConversationHistory(): Promise<ApiMessage[]>
	saveApiConversationHistory(): Promise<boolean>
	initiateTaskLoop(userMessage: any[]): Promise<void>

	// Event emitter
	emit(event: string, ...args: any[]): boolean
}

export type { IsolationLevel, ForkedContextConfig, CacheSafeParams }
