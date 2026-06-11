/**
 * TaskAskSayHost — Interface for TaskAskSayHandler dependency injection.
 *
 * Defines the minimal surface TaskAskSayHandler needs from its owning Task.
 * Extracted from Task.ts as part of Phase 1 decomposition.
 */
import type {
	ClineAsk,
	ClineAskResponse,
	ClineMessage,
	ToolProgressStatus,
	ContextCondense,
	ContextTruncation,
	ToolName,
} from "@njust-ai/types"
import type { TaskMessageManager } from "../TaskMessageManager"

export interface QueuedMessage {
	text?: string
	images?: string[]
}

export interface MessageQueueService {
	isEmpty(): boolean
	dequeueMessage(): QueuedMessage | undefined
}

export interface TaskAskSayHost {
	// Identity
	readonly taskId: string
	readonly instanceId: string

	// Mutable state (required for handler operations)
	abort: boolean
	lastMessageTs: number
	askResponse?: ClineAskResponse
	askResponseText?: string
	askResponseImages?: string[]
	autoApprovalTimeoutRef?: NodeJS.Timeout

	// Message state
	clineMessages: ClineMessage[]
	interactiveAsk?: ClineMessage
	resumableAsk?: ClineMessage
	idleAsk?: ClineMessage

	// Services
	messageQueueService: MessageQueueService

	// Event emitter
	emit(event: string, ...args: unknown[]): boolean

	// Notifier
	notifier?: {
		postStateToWebviewWithoutTaskHistory(): Promise<void>
		postMessageToWebview(message: UnsafeAny): Promise<void>
		updateTaskHistory(item: UnsafeAny): Promise<void>
	}

	// Message persistence (via msgMgr)
	msgMgr: TaskMessageManager

	// Task methods needed by handler
	addToClineMessages(message: Omit<ClineMessage, "id"> & { id?: string }): Promise<void>
	updateClineMessage(message: ClineMessage): Promise<void>
	saveClineMessages(): Promise<boolean>
	findMessageByTimestamp(ts: number): ClineMessage | undefined

	// Checkpoint
	checkpointSave(allowEmpty?: boolean, suppressChatRow?: boolean): Promise<void>

	// Provider reference (for state access)
	hostRef: { deref(): UnsafeAny }

	// Helper methods needed by handler
	cancelAutoApprovalTimeout(): void
	approveAsk(opts?: { text?: string; images?: string[] }): void
	denyAsk(opts?: { text?: string; images?: string[] }): void
	supersedePendingAsk(): void
	updateApiConfiguration(newApiConfiguration: UnsafeAny): void
	formatResponse: {
		toolError(error: string): string
		missingToolParameterError(paramName: string): string
	}
}

export type {
	ClineAsk,
	ClineAskResponse,
	ClineMessage,
	ToolProgressStatus,
	ContextCondense,
	ContextTruncation,
	ToolName,
}
