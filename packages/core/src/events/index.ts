/**
 * Minimal contract for the task-scoped event bus.
 *
 * The api/ layer emits retry events via this bus but should not depend
 * on the concrete TaskEventBus implementation in src/core/events/
 * (which has VS Code logging concerns and may move in the future).
 * Host code injects the actual bus at extension activation.
 */

export type TaskEventName =
	| "task:started"
	| "task:completed"
	| "task:failed"
	| "task:aborted"
	| "task:tool-executing"
	| "task:tool-completed"
	| "task:llm-response"
	| "task:tokens-updated"
	| "task:llm-retry"
	| "task:assistant-message-requested"

export interface TaskEventPayload {
	taskId?: string
	data?: unknown
}

export interface DisposableLike {
	dispose(): void
}

export interface ITaskEventBus {
	emit(event: TaskEventName, payload?: TaskEventPayload): void
	emitAsync?(event: TaskEventName, payload?: TaskEventPayload): Promise<void>
	on?(event: TaskEventName, listener: (event: TaskEventName, payload: TaskEventPayload) => void): DisposableLike
	off?(event: TaskEventName, listener: (event: TaskEventName, payload: TaskEventPayload) => void): void
}
