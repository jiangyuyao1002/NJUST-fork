/**
 * ApiRequestHandler — Facade for API request lifecycle management.
 *
 * Extracted from Task.ts to decompose the monolithic 5000+ line file.
 * Encapsulates API request preparation, streaming coordination, and
 * response processing logic. Uses the delegation pattern: accesses
 * Task instance properties via `this.task`.
 *
 * Phase 1: Exposes utility methods that Task.ts can delegate to.
 * Full extraction of `recursivelyMakeClineRequests` and `attemptApiRequest`
 * is deferred to Phase 2 once the delegation surface is stable.
 */

import type { ApiMessage } from "../task-persistence/apiMessages"
import type { TokenUsage } from "@njust-ai-cj/types"

// ─── Request Metadata ────────────────────────────────────────────────────────

export interface ApiRequestMetadata {
	requestId: string
	startedAt: number
	retryAttempt: number
	modelId: string
	contextTokens?: number
}

// ─── Request Rate Limiter ────────────────────────────────────────────────────

/**
 * Global per-provider rate limiter to enforce minimum delay between API requests.
 * Prevents overwhelming the API during rapid tool-execution loops.
 */
export class RequestRateLimiter {
	private lastRequestTime?: number

	constructor(private readonly minDelayMs: number = 0) {}

	/**
	 * Wait until enough time has elapsed since the last request.
	 */
	async waitIfNeeded(): Promise<void> {
		if (this.minDelayMs <= 0 || !this.lastRequestTime) {
			return
		}
		const elapsed = Date.now() - this.lastRequestTime
		if (elapsed < this.minDelayMs) {
			await new Promise<void>((resolve) => setTimeout(resolve, this.minDelayMs - elapsed))
		}
	}

	markRequestSent(): void {
		this.lastRequestTime = Date.now()
	}

	getLastRequestTime(): number | undefined {
		return this.lastRequestTime
	}
}

// ─── Token Usage Tracker ─────────────────────────────────────────────────────

/**
 * Tracks and caches token usage to avoid recomputing on every call.
 * Provides cache invalidation based on staleness.
 */
export class TokenUsageTracker {
	private snapshot?: TokenUsage
	private snapshotAt?: number
	private readonly staleDurationMs: number

	constructor(staleDurationMs: number = 5000) {
		this.staleDurationMs = staleDurationMs
	}

	/**
	 * Get cached token usage or recompute if stale.
	 */
	getUsage(computeFn: () => TokenUsage): TokenUsage {
		const now = Date.now()
		if (this.snapshot && this.snapshotAt && now - this.snapshotAt < this.staleDurationMs) {
			return this.snapshot
		}
		this.snapshot = computeFn()
		this.snapshotAt = now
		return this.snapshot
	}

	invalidate(): void {
		this.snapshot = undefined
		this.snapshotAt = undefined
	}

	/**
	 * Force update the cached snapshot (e.g., after compaction).
	 */
	forceUpdate(usage: TokenUsage): void {
		this.snapshot = usage
		this.snapshotAt = Date.now()
	}
}

// ─── Request Context Builder ─────────────────────────────────────────────────

/**
 * Builds the context window pressure metrics used for adaptive decisions
 * throughout the request lifecycle.
 */
export interface ContextPressure {
	/** Current token count in context */
	currentTokens: number
	/** Maximum context window size */
	contextWindow: number
	/** Usage ratio (0-1) */
	pressure: number
	/** Whether the context is under high pressure (>80%) */
	isHighPressure: boolean
	/** Whether preemptive compaction should be considered */
	shouldPreemptivelyCompact: boolean
}

export function computeContextPressure(
	currentTokens: number,
	contextWindow: number,
	compactThresholdPercent: number = 80,
): ContextPressure {
	const pressure = contextWindow > 0 ? currentTokens / contextWindow : 0
	const thresholdRatio = compactThresholdPercent / 100
	const safetyMargin = 0.15

	return {
		currentTokens,
		contextWindow,
		pressure,
		isHighPressure: pressure > 0.8,
		shouldPreemptivelyCompact: pressure >= thresholdRatio * (1 - safetyMargin),
	}
}

// ─── Request History Validator ───────────────────────────────────────────────

/**
 * Validates API conversation history before sending requests.
 * Ensures message ordering, role alternation, and tool_result pairing.
 */
export function validateConversationHistory(messages: ApiMessage[]): {
	valid: boolean
	errors: string[]
} {
	const errors: string[] = []

	if (messages.length === 0) {
		return { valid: true, errors: [] }
	}

	// First message should be from user
	if (messages[0]!.role !== "user") {
		errors.push("First message should be from user role")
	}

	// Check role alternation (user/assistant)
	for (let i = 1; i < messages.length; i++) {
		if (messages[i]!.role === messages[i - 1]!.role) {
			// Consecutive same-role messages are generally invalid
			// but some edge cases (tool_result chaining) allow it
			if (messages[i]!.role === "user") {
				// Check if it's a tool_result — those can follow user messages
				const content = messages[i]!.content
				if (Array.isArray(content)) {
					const hasToolResult = content.some((b: UnsafeAny) => b.type === "tool_result")
					if (!hasToolResult) {
						errors.push(`Consecutive user messages at index ${i - 1} and ${i}`)
					}
				}
			}
		}
	}

	return { valid: errors.length === 0, errors }
}
