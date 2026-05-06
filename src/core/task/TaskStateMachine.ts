export enum TaskState {
	IDLE = "IDLE",
	PREPARING = "PREPARING",
	STREAMING = "STREAMING",
	PROCESSING_TOOLS = "PROCESSING_TOOLS",
	COMPACTING = "COMPACTING",
	RECOVERING_MAX_TOKENS = "RECOVERING_MAX_TOKENS",
	WAITING_APPROVAL = "WAITING_APPROVAL",
	COMPLETED = "COMPLETED",
	ERROR = "ERROR",
}

const ALLOWED_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
	[TaskState.IDLE]: new Set([TaskState.PREPARING, TaskState.ERROR, TaskState.COMPLETED]),
	[TaskState.PREPARING]: new Set([TaskState.STREAMING, TaskState.COMPACTING, TaskState.ERROR]),
	[TaskState.STREAMING]: new Set([
		TaskState.PROCESSING_TOOLS,
		TaskState.COMPACTING,
		TaskState.RECOVERING_MAX_TOKENS,
		TaskState.WAITING_APPROVAL,
		TaskState.COMPLETED,
		TaskState.ERROR,
	]),
	[TaskState.PROCESSING_TOOLS]: new Set([
		TaskState.PREPARING,
		TaskState.WAITING_APPROVAL,
		TaskState.COMPLETED,
		TaskState.ERROR,
	]),
	[TaskState.COMPACTING]: new Set([TaskState.PREPARING, TaskState.ERROR]),
	[TaskState.RECOVERING_MAX_TOKENS]: new Set([TaskState.PREPARING, TaskState.ERROR]),
	[TaskState.WAITING_APPROVAL]: new Set([TaskState.PREPARING, TaskState.ERROR, TaskState.COMPLETED]),
	[TaskState.COMPLETED]: new Set([TaskState.PREPARING, TaskState.PROCESSING_TOOLS]),
	[TaskState.ERROR]: new Set([TaskState.PREPARING, TaskState.RECOVERING_MAX_TOKENS]),
}

export class TaskStateMachine {
	private _state: TaskState = TaskState.IDLE
	private _previousState: TaskState = TaskState.IDLE
	private _forceLocked = false

	get state(): TaskState {
		return this._state
	}

	get previousState(): TaskState {
		return this._previousState
	}

	canTransition(to: TaskState): boolean {
		return this._state === to || ALLOWED_TRANSITIONS[this._state].has(to)
	}

	transition(to: TaskState): void {
		if (!this.canTransition(to)) {
			throw new Error(`Invalid task state transition: ${this._state} -> ${to}`)
		}
		this._previousState = this._state
		this._state = to
	}

	rollback(): void {
		this._state = this._previousState
	}

	/**
	 * Force a state transition, skipping validation.
	 * Concurrency-protected: overlapping force() calls are rejected.
	 * Prefer {@link transition} for normal flows.
	 */
	force(to: TaskState, source?: string): void {
		if (this._state === to) return
		if (this._forceLocked) {
			console.error(
				`[TaskStateMachine] force() rejected (concurrent): ${this._state} -> ${to}` +
				(source ? ` [source: ${source}]` : ""),
			)
			return
		}
		this._forceLocked = true
		try {
			if (!this.canTransition(to)) {
				console.warn(
					`[TaskStateMachine] Unsafe transition: ${this._state} -> ${to}` +
					(source ? ` [source: ${source}]` : ""),
				)
			}
			this._previousState = this._state
			this._state = to
		} finally {
			this._forceLocked = false
		}
	}
}
