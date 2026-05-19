import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiStream } from "../../api/transform/stream"
import type { TaskExecutorHost } from "./interfaces/ITaskExecutorHost"
import { TaskState } from "./TaskStateMachine"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { TaskAbortedError, TaskRetryExhaustedError } from "./TaskErrors"

interface RetryApiRequest {
	(retryAttempt?: number, options?: { skipProviderRateLimit?: boolean }): ApiStream
}

export async function* handleAttemptApiRequestError(options: {
	host: TaskExecutorHost
	error: UnsafeAny
	retryAttempt: number
	autoApprovalEnabled: boolean | undefined
	unattendedRetryEnabled: boolean
	unattendedMaxRetryAttempts: number
	retryApiRequest: RetryApiRequest
}): ApiStream {
	const {
		host,
		error,
		retryAttempt,
		autoApprovalEnabled,
		unattendedRetryEnabled,
		unattendedMaxRetryAttempts,
		retryApiRequest,
	} = options

	host.isWaitingForFirstChunk = false
	host.currentRequestAbortController = undefined

	const persistentRetryHandler =
		host.persistentRetryHandler ?? (host.persistentRetryHandler = new (await import("./PersistentRetry")).PersistentRetryManager())

	const recovery = await host.errorRecovery.handleApiError(error, retryAttempt)
	if (recovery.action === "retry") {
		yield* retryApiRequest(recovery.nextAttempt)
		return
	}

	if (autoApprovalEnabled) {
		host.stateMachine.force(TaskState.RECOVERING_MAX_TOKENS)
		if (unattendedRetryEnabled && retryAttempt >= unattendedMaxRetryAttempts) {
			const { classifyApiError } = await import("../errors/apiErrorClassifier")
			const errorType = classifyApiError(error)
			if (persistentRetryHandler.isEligible(errorType)) {
				const taskHost = host.hostRef.deref()
				if (taskHost?.log) {
					taskHost.log(`[Task#${host.taskId}] Normal retry limit reached. Entering persistent retry for ${errorType}...`)
				}
				try {
					await persistentRetryHandler.waitForRetry(errorType, (message, _retryCount, _elapsed) => {
						void host.say("api_req_retry_delayed", message, undefined, true)
					})
				} catch (persistentErr) {
					const stats = persistentRetryHandler.getStats()
					throw new Error(
						`[Task#${host.taskId}] Persistent retry ended after ${stats.totalRetries} attempts: ${getErrorMessage(persistentErr)}`,
					)
				}

				if (host.abort) {
					persistentRetryHandler.cancel()
					throw new TaskAbortedError(host.taskId, host.instanceId)
				}

				yield* retryApiRequest(retryAttempt + 1)
				return
			}

			throw new TaskRetryExhaustedError(host.taskId, unattendedMaxRetryAttempts)
		}

		await host.streamProcessor.backoffAndAnnounce(retryAttempt, error)
		if (host.abort) {
			throw new TaskAbortedError(host.taskId, host.instanceId)
		}

		yield* retryApiRequest(retryAttempt + 1)
		return
	}

	host.stateMachine.force(TaskState.ERROR)
	const { response } = await host.ask("api_req_failed", getErrorMessage(error))

	if (response !== "yesButtonClicked") {
		throw new Error("API request failed")
	}

	await host.say("api_req_retried")
	yield* retryApiRequest()
}

export async function handleMidStreamFailure(options: {
	task: TaskExecutorHost
	error: UnsafeAny
	currentRetryAttempt: number
	currentUserContent: Anthropic.Messages.ContentBlockParam[]
	stack: Array<{
		userContent: Anthropic.Messages.ContentBlockParam[]
		includeFileDetails: boolean
		retryAttempt?: number
		userMessageWasRemoved?: boolean
	}>
	streamingFailedMessage?: string
	abortStream(cancelReason: "user_cancelled" | "streaming_failed", streamingFailedMessage?: string): Promise<void>
}): Promise<"continue" | "break" | "handled"> {
	const { task, error, currentRetryAttempt, currentUserContent, stack, streamingFailedMessage, abortStream } = options

	if (task.abandoned) {
		return "handled"
	}

	const cancelReason = task.abort ? "user_cancelled" : "streaming_failed"
	await abortStream(cancelReason, streamingFailedMessage)

	if (task.abort) {
		task.abortReason = cancelReason
		await task.abortTask()
		return "break"
	}

	logger.error(
		"TaskExecutor",
		`Stream failed for task ${task.taskId}.${task.instanceId}, will retry: ${streamingFailedMessage}`,
	)

	const stateForBackoff = await task.hostRef.deref()?.getState()
	if (stateForBackoff?.autoApprovalEnabled) {
		await task.backoffAndAnnounce(currentRetryAttempt, error)
		if (task.abort) {
			logger.info(
				"TaskExecutor",
				`Task aborted during mid-stream retry backoff for task ${task.taskId}.${task.instanceId}`,
			)
			task.abortReason = "user_cancelled"
			await task.abortTask()
			return "break"
		}
	}

	stack.push({
		userContent: currentUserContent,
		includeFileDetails: false,
		retryAttempt: currentRetryAttempt + 1,
	})

	return "continue"
}

export async function handleEmptyAssistantResponse(options: {
	task: TaskExecutorHost
	currentRetryAttempt: number
	currentUserContent: Anthropic.Messages.ContentBlockParam[]
	stack: Array<{
		userContent: Anthropic.Messages.ContentBlockParam[]
		includeFileDetails: boolean
		retryAttempt?: number
		userMessageWasRemoved?: boolean
	}>
}): Promise<"continue" | "break" | "done"> {
	const { task, currentRetryAttempt, currentUserContent, stack } = options

	task.consecutiveNoAssistantMessagesCount++
	if (task.consecutiveNoAssistantMessagesCount >= 2) {
		await task.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
	}

	const state = await task.hostRef.deref()?.getState()
	if (task.apiConversationHistory.length > 0) {
		const lastMessage = task.apiConversationHistory[task.apiConversationHistory.length - 1]
		if (lastMessage?.role === "user") {
			task.apiConversationHistory.pop()
		}
	}

	if (state?.autoApprovalEnabled) {
		await task.backoffAndAnnounce(
			currentRetryAttempt,
			new Error(
				"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
			),
		)

		if (task.abort) {
			logger.info(
				"TaskExecutor",
				`Task aborted during empty-assistant retry backoff for task ${task.taskId}.${task.instanceId}`,
			)
			return "break"
		}

		stack.push({
			userContent: currentUserContent,
			includeFileDetails: false,
			retryAttempt: currentRetryAttempt + 1,
			userMessageWasRemoved: true,
		})

		return "continue"
	}

	const { response } = await task.ask(
		"api_req_failed",
		"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
	)

	if (response === "yesButtonClicked") {
		await task.say("api_req_retried")
		stack.push({
			userContent: currentUserContent,
			includeFileDetails: false,
			retryAttempt: currentRetryAttempt + 1,
		})
		return "continue"
	}

	await task.addToApiConversationHistory({
		role: "user",
		content: currentUserContent,
	})

	await task.say(
		"error",
		"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
	)

	await task.addToApiConversationHistory({
		role: "assistant",
		content: [{ type: "text", text: "Failure: I did not provide a response." }],
	})

	return "done"
}
