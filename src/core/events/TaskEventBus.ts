import * as vscode from "vscode"

import { debugLog } from "../../utils/debugLog"
import { logger } from "../../shared/logger"
/** Task-scoped domain events (B.1). */
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

export type TaskEventPayload = {
	taskId?: string
	data?: unknown
}

export type TaskEventListener = (event: TaskEventName, payload: TaskEventPayload) => void

/**
 * Optional middleware: log every emit (dev / diagnostics). No-op by default.
 */
export type TaskEventBusMiddleware = (
	event: TaskEventName,
	payload: TaskEventPayload,
	next: () => void,
) => void

export class TaskEventBus {
	private readonly listeners = new Map<TaskEventName, Set<TaskEventListener>>()
	private middleware: TaskEventBusMiddleware | undefined

	setMiddleware(mw: TaskEventBusMiddleware | undefined): void {
		this.middleware = mw
	}

	on(event: TaskEventName, listener: TaskEventListener): vscode.Disposable {
		let set = this.listeners.get(event)
		if (!set) {
			set = new Set()
			this.listeners.set(event, set)
		}
		set.add(listener)
		return new vscode.Disposable(() => {
			set?.delete(listener)
		})
	}

	off(event: TaskEventName, listener: TaskEventListener): void {
		this.listeners.get(event)?.delete(listener)
	}

	emit(event: TaskEventName, payload: TaskEventPayload = {}): void {
		const run = () => {
			const set = this.listeners.get(event)
			if (!set) {
				return
			}
			for (const listener of [...set]) {
				try {
					listener(event, payload)
				} catch (e) {
					logger.error("TaskEventBus", `listener error for ${event}:`, e)
				}
			}
		}

		if (this.middleware) {
			this.middleware(event, payload, run)
		} else {
			run()
		}
	}
}

/** Global bus for task lifecycle / tool / LLM telemetry hooks. */
export const taskEventBus = new TaskEventBus()

/** Enable verbose logging when NODE_ENV === "development" or TASK_EVENT_BUS_DEBUG=1 */
export function enableTaskEventBusDebugLogging(): void {
	taskEventBus.setMiddleware((event, payload, next) => {
		debugLog("[TaskEventBus]", event, payload)
		next()
	})
}
