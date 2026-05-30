/**
 * TaskLifecycle — Task lifecycle utilities.
 *
 * Extracted from Task.ts to decompose the monolithic file.
 * Runtime state machine is in TaskStateMachine.ts (TaskState enum).
 */

import type { ClineMessage } from "@njust-ai/types"
import { logger } from "../../shared/logger"
import { clineApiReqInfoSchema } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"

// ─── History Message Cleanup ─────────────────────────────────────────────────

/**
 * Clean up stale messages from a saved message history for task resumption.
 * Removes trailing resume prompts, orphaned reasoning blocks, and
 * incomplete API request markers.
 *
 * @param messages - Saved cline messages from the previous session
 * @returns Cleaned messages ready for resumption display
 */
export function cleanHistoryForResumption(messages: ClineMessage[]): ClineMessage[] {
	const result = [...messages]

	// 1. Remove trailing resume messages
	while (result.length > 0) {
		const last = result[result.length - 1]!
		if (last.ask === "resume_task" || last.ask === "resume_completed_task") {
			result.pop()
		} else {
			break
		}
	}

	// 2. Remove trailing reasoning-only UI messages
	while (result.length > 0) {
		const last = result[result.length - 1]!
		if (last.type === "say" && last.say === "reasoning") {
			result.pop()
		} else {
			break
		}
	}

	// 3. Remove incomplete API request markers (no cost and no cancel reason)
	const lastApiReqIndex = findLastIndex(result, (m) => m.type === "say" && m.say === "api_req_started")

	if (lastApiReqIndex !== -1) {
		try {
			const info = clineApiReqInfoSchema.parse(JSON.parse(result[lastApiReqIndex]!.text || "{}"))
			if (info.cost === undefined && info.cancelReason === undefined) {
				result.splice(lastApiReqIndex, 1)
			}
		} catch {
			// If we can't parse the JSON, leave it as-is
		}
	}

	return result
}

/**
 * Determine the appropriate resume ask type based on the last meaningful message.
 */
export function getResumeAskType(messages: ClineMessage[]): "resume_task" | "resume_completed_task" {
	const lastMeaningful = [...messages]
		.reverse()
		.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))

	return lastMeaningful?.ask === "completion_result" ? "resume_completed_task" : "resume_task"
}

// ─── Subtask Budget Checker ──────────────────────────────────────────────────

export interface SubtaskBudgetStatus {
	/** Whether the subtask is approaching its budget limit */
	isApproachingLimit: boolean
	/** Current token usage of the subtask */
	subtaskTokens: number
	/** Remaining budget from parent */
	parentRemaining: number
	/** Usage percentage of parent's remaining budget */
	usagePercent: number
}

/**
 * Check whether a subtask is approaching its parent's remaining token budget.
 */
export function checkSubtaskBudget(
	subtaskTokens: number,
	parentContextTokens: number,
	contextWindow: number,
	warningThreshold: number = 0.8,
): SubtaskBudgetStatus {
	const parentRemaining = contextWindow - parentContextTokens
	const usagePercent = parentRemaining > 0 ? subtaskTokens / parentRemaining : 1

	return {
		isApproachingLimit: usagePercent > warningThreshold,
		subtaskTokens,
		parentRemaining,
		usagePercent,
	}
}

// ─── Dispose Helpers ─────────────────────────────────────────────────────────

/**
 * Execute a cleanup function, catching and logging any error to prevent
 * one failing dispose step from blocking subsequent steps.
 */
export function safeDispose(label: string, fn: () => void): void {
	try {
		fn()
	} catch (error) {
		logger.error("TaskLifecycle", `Error during dispose (${label}):`, error)
		TelemetryService.reportError(error instanceof Error ? error : new Error(String(error)), TelemetryEventName.UTILITY_ERROR)
	}
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

function findLastIndex<T>(array: T[], predicate: (item: T) => boolean): number {
	for (let i = array.length - 1; i >= 0; i--) {
		if (predicate(array[i]!)) {
			return i
		}
	}
	return -1
}
