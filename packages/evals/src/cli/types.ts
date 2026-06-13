import { NamedError } from "@njust-ai/types"
import { type TaskEvent } from "@njust-ai/types"

import type { Run, Task } from "../db/index"
import { Logger } from "./utils"

export class SubprocessTimeoutError extends NamedError {
	constructor(timeout: number) {
		super(`Subprocess timeout after ${timeout}ms`)
	}
}

export type RunTaskOptions = {
	run: Run
	task: Task
	jobToken: string | null
	publish: (taskEvent: TaskEvent) => Promise<void>
	logger: Logger
}
