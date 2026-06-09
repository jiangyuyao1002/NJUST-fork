import { debugLog } from "../../utils/debugLog"
import { logger } from "../../shared/logger"

import type { DisposableLike, ITaskEventBus, TaskEventName, TaskEventPayload } from "@njust-ai/core/events"

export type { DisposableLike, TaskEventName, TaskEventPayload }
export type { ITaskEventBus } from "@njust-ai/core/events"

class Disposable implements DisposableLike {
	constructor(private readonly disposeFn: () => void) {}

	dispose(): void {
		this.disposeFn()
	}
}

export type TaskEventListener = (event: TaskEventName, payload: TaskEventPayload) => void | Promise<void>

/**
 * Optional middleware: log every emit (dev / diagnostics). No-op by default.
 */
export type TaskEventBusMiddleware = (event: TaskEventName, payload: TaskEventPayload, next: () => void) => void

export class TaskEventBus implements ITaskEventBus {
	private readonly listeners = new Map<TaskEventName, Set<TaskEventListener>>()
	private middleware: TaskEventBusMiddleware | undefined

	setMiddleware(mw: TaskEventBusMiddleware | undefined): void {
		this.middleware = mw
	}

	on(event: TaskEventName, listener: TaskEventListener): DisposableLike {
		let set = this.listeners.get(event)
		if (!set) {
			set = new Set()
			this.listeners.set(event, set)
		}
		set.add(listener)
		return new Disposable(() => {
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
					void listener(event, payload)
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

	async emitAsync(event: TaskEventName, payload: TaskEventPayload = {}): Promise<void> {
		const run = async () => {
			const set = this.listeners.get(event)
			if (!set) {
				return
			}
			for (const listener of [...set]) {
				try {
					await listener(event, payload)
				} catch (e) {
					logger.error("TaskEventBus", `listener error for ${event}:`, e)
				}
			}
		}

		if (this.middleware) {
			await new Promise<void>((resolve) => {
				this.middleware!(event, payload, () => {
					void run().finally(resolve)
				})
			})
		} else {
			await run()
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
