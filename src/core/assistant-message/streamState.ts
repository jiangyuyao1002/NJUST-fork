export interface AssistantStreamState {
	didCompleteReadingStream: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContentReady: boolean
}

/**
 * If the stream has finished and there are no more blocks to process,
 * mark userMessageContentReady so the executor's pWaitFor can proceed.
 */
export function markUserContentReadyIfDrained(state: AssistantStreamState): void {
	if (state.didCompleteReadingStream && state.currentStreamingContentIndex >= state.assistantMessageContent.length) {
		state.userMessageContentReady = true
	}
}
