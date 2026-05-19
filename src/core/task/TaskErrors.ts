export class TaskAbortedError extends Error {
	public readonly taskId: string
	public readonly instanceId: string

	constructor(taskId: string, instanceId: string) {
		super(`task ${taskId}.${instanceId} aborted`)
		this.name = "TaskAbortedError"
		this.taskId = taskId
		this.instanceId = instanceId
		Object.setPrototypeOf(this, TaskAbortedError.prototype)
	}
}

export class TaskRetryExhaustedError extends Error {
	public readonly retryAttempts: number

	constructor(taskId: string, retryAttempts: number) {
		super(`[Task#${taskId}] Unattended retry limit reached (${retryAttempts}).`)
		this.name = "TaskRetryExhaustedError"
		this.retryAttempts = retryAttempts
		Object.setPrototypeOf(this, TaskRetryExhaustedError.prototype)
	}
}

export class TaskAutoApprovalError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "TaskAutoApprovalError"
		Object.setPrototypeOf(this, TaskAutoApprovalError.prototype)
	}
}
