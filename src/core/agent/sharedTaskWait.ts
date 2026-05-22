import type { AgentTaskLike } from "./AgentTaskController"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_MAX_POLLS = 1200

export interface WaitForTaskCompletionOptions {
	timeoutMs?: number
	pollIntervalMs?: number
	maxPolls?: number
	timeoutMessage?: string
	completedMessage?: string
	noResultMessage?: string
}

export function waitForTaskCompletion(
	task: AgentTaskLike,
	options: WaitForTaskCompletionOptions = {},
): Promise<string> {
	const {
		timeoutMs = DEFAULT_TIMEOUT_MS,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		maxPolls = DEFAULT_MAX_POLLS,
		timeoutMessage = "Task execution timed out",
		completedMessage = "Task completed",
		noResultMessage = "Task completed (no explicit result)",
	} = options

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			clearInterval(pollInterval)
			reject(new Error(timeoutMessage))
		}, timeoutMs)

		let pollCount = 0
		const pollInterval = setInterval(() => {
			try {
				if (++pollCount > maxPolls) {
					clearInterval(pollInterval)
					clearTimeout(timeout)
					reject(new Error("Task reached maximum poll count"))
					return
				}

				const messages = task.clineMessages || []
				const lastMsg = messages[messages.length - 1]

				if (lastMsg?.type === "say" && lastMsg.say === "completion_result") {
					clearInterval(pollInterval)
					clearTimeout(timeout)
					resolve(lastMsg.text || completedMessage)
					return
				}

				if (task.didFinishAbortingStream || task.abandoned) {
					clearInterval(pollInterval)
					clearTimeout(timeout)

					const errorMsg = messages.find((m) => m.type === "say" && m.say === "error")
					if (errorMsg) {
						reject(new Error(errorMsg.text || "Task failed"))
					} else {
						resolve(noResultMessage)
					}
					return
				}
			} catch (error) {
				clearInterval(pollInterval)
				clearTimeout(timeout)
				reject(error)
			}
		}, pollIntervalMs)
	})
}
