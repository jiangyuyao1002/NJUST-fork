import { NamedError } from "@njust-ai/core/shared"

export class TaskAbortedError extends NamedError {
	public readonly taskId: string
	public readonly instanceId: string

	constructor(taskId: string, instanceId: string) {
		super(`task ${taskId}.${instanceId} aborted`)
		this.taskId = taskId
		this.instanceId = instanceId
	}
}

export class TaskRetryExhaustedError extends NamedError {
	public readonly retryAttempts: number

	constructor(taskId: string, retryAttempts: number) {
		super(`[Task#${taskId}] Unattended retry limit reached (${retryAttempts}).`)
		this.retryAttempts = retryAttempts
	}
}

export class TaskAutoApprovalError extends NamedError {
	constructor(message: string) {
		super(message)
	}
}
