/**
 * Persistent Retry State Manager
 *
 * Tracks retry counts across API requests within a task session.
 * Unlike per-request retry, this maintains state across the entire task lifecycle,
 * preventing infinite retry loops and enabling progressive degradation.
 *
 * **Relation to `ApiRetryStrategy` / `DEFAULT_API_RETRY_OPTIONS`:** those control a **single**
 * transport attempt (e.g. one `fetch` or stream open). This module caps **session-level**
 * and **per-category** retries across turns; keep both layers when tuning behavior.
 */

export interface RetryRecord {
	errorCategory: string
	count: number
	firstOccurrence: number // timestamp
	lastOccurrence: number // timestamp
	totalDelayMs: number // accumulated delay
}

export interface PersistentRetryConfig {
	/** Max total retries across all error types within a session */
	maxTotalRetries: number // default: 30
	/** Max retries per error category */
	maxPerCategoryRetries: Record<string, number>
	/** Time window (ms) to reset counters if no errors occur */
	resetWindowMs: number // default: 5 minutes
}

const DEFAULT_CONFIG: PersistentRetryConfig = {
	maxTotalRetries: 30,
	maxPerCategoryRetries: {
		rate_limit: 15,
		capacity: 10,
		model_overloaded: 8,
		timeout: 5,
		connection: 10,
		server_error: 5,
		invalid_tool_use: 3,
		context_window: 3,
		media_too_large: 2,
		content_policy: 1, // don't retry content policy
		authentication: 1, // don't retry auth
		partial_response: 5,
		unknown: 3,
	},
	resetWindowMs: 5 * 60 * 1000,
}

/**
 * Base delays (ms) per error category for exponential backoff calculation.
 * Categories not listed here default to 1000ms.
 */
const BASE_DELAYS: Record<string, number> = {
	rate_limit: 2000,
	capacity: 3000,
	model_overloaded: 5000,
	timeout: 2000,
	connection: 1000,
	server_error: 2000,
	invalid_tool_use: 500,
	context_window: 1000,
	media_too_large: 1000,
	content_policy: 1000,
	authentication: 1000,
	partial_response: 1000,
	unknown: 1000,
}

const MAX_SUGGESTED_DELAY_MS = 120_000 // 2 minutes cap
const MAX_EXPONENT = 12 // Cap exponent to prevent unbounded Math.pow(2, ...) growth

export class PersistentRetryManager {
	private records: Map<string, RetryRecord> = new Map()
	private totalRetries: number = 0
	private config: PersistentRetryConfig
	private lastErrorTime: number = 0
	private cancelled: boolean = false

	constructor(config?: Partial<PersistentRetryConfig>) {
		this.config = {
			maxTotalRetries: config?.maxTotalRetries ?? DEFAULT_CONFIG.maxTotalRetries,
			maxPerCategoryRetries: {
				...DEFAULT_CONFIG.maxPerCategoryRetries,
				...(config?.maxPerCategoryRetries ?? {}),
			},
			resetWindowMs: config?.resetWindowMs ?? DEFAULT_CONFIG.resetWindowMs,
		}
	}

	/**
	 * Check if a given error type is eligible for persistent retry.
	 */
	isEligible(errorCategory: string): boolean {
		const result = this.canRetry(errorCategory)
		return result.allowed
	}

	/**
	 * Wait for retry with exponential backoff. Calls the heartbeat callback
	 * periodically while waiting. Throws if cancelled or retries exhausted.
	 */
	async waitForRetry(
		errorCategory: string,
		heartbeat?: (message: string, retryCount: number, elapsed: number) => void,
	): Promise<void> {
		const check = this.canRetry(errorCategory)
		if (!check.allowed) {
			throw new Error(check.reason)
		}

		const delayMs = check.suggestedDelayMs
		const startTime = Date.now()

		// Send heartbeat before waiting
		if (heartbeat) {
			heartbeat(
				`Persistent retry: waiting ${Math.round(delayMs / 1000)}s for '${errorCategory}' (attempt ${this.totalRetries + 1})`,
				this.totalRetries + 1,
				Date.now() - startTime,
			)
		}

		// Wait with cancellation support
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.cancelled) {
					reject(new Error("Persistent retry cancelled"))
				} else {
					resolve()
				}
			}, delayMs)

			// Check cancellation periodically
			const checkInterval = setInterval(() => {
				if (this.cancelled) {
					clearTimeout(timer)
					clearInterval(checkInterval)
					reject(new Error("Persistent retry cancelled"))
				}
			}, 1000)

			// Clean up interval when timer fires
			const origResolve = resolve
			resolve = (() => {
				clearInterval(checkInterval)
				origResolve()
			}) as typeof resolve
		})

		this.recordRetry(errorCategory, delayMs)
	}

	/**
	 * Cancel any pending persistent retry wait.
	 */
	cancel(): void {
		this.cancelled = true
	}

	/**
	 * Check if retry is allowed for the given error category.
	 * Returns { allowed, reason, suggestedDelayMs, shouldFallback }
	 */
	canRetry(errorCategory: string): {
		allowed: boolean
		reason: string
		suggestedDelayMs: number
		shouldFallback: boolean // true if retries exhausted, suggest model fallback
	} {
		// Auto-reset if enough time has passed without errors
		this.maybeResetOnQuietWindow()

		const categoryMax =
			this.config.maxPerCategoryRetries[errorCategory] ?? DEFAULT_CONFIG.maxPerCategoryRetries.unknown ?? 3
		const record = this.records.get(errorCategory)
		const categoryCount = record?.count ?? 0

		// Exponential backoff with jitter to prevent thundering herd
		// when multiple agents hit rate limits simultaneously.
		const baseDelay = BASE_DELAYS[errorCategory] ?? 1000
		const effectiveCount = Math.min(categoryCount, MAX_EXPONENT)
		const rawDelayMs = Math.min(baseDelay * Math.pow(2, effectiveCount), MAX_SUGGESTED_DELAY_MS)
		const jitterFactor = 0.75 + Math.random() * 0.5
		const suggestedDelayMs = Math.round(rawDelayMs * jitterFactor)

		// Check total retries exceeded
		if (this.totalRetries >= this.config.maxTotalRetries) {
			return {
				allowed: false,
				reason: `Total retry limit reached (${this.totalRetries}/${this.config.maxTotalRetries})`,
				suggestedDelayMs,
				shouldFallback: true,
			}
		}

		// Check per-category limit exceeded
		if (categoryCount >= categoryMax) {
			return {
				allowed: false,
				reason: `Category '${errorCategory}' retry limit reached (${categoryCount}/${categoryMax})`,
				suggestedDelayMs,
				shouldFallback: true,
			}
		}

		return {
			allowed: true,
			reason: `Retry allowed for '${errorCategory}' (${categoryCount + 1}/${categoryMax}, total ${this.totalRetries + 1}/${this.config.maxTotalRetries})`,
			suggestedDelayMs,
			shouldFallback: false,
		}
	}

	/**
	 * Record a retry attempt for the given error category.
	 */
	recordRetry(errorCategory: string, delayMs: number): void {
		const now = Date.now()
		this.lastErrorTime = now

		const existing = this.records.get(errorCategory)
		if (existing) {
			existing.count++
			existing.lastOccurrence = now
			existing.totalDelayMs += delayMs
		} else {
			this.records.set(errorCategory, {
				errorCategory,
				count: 1,
				firstOccurrence: now,
				lastOccurrence: now,
				totalDelayMs: delayMs,
			})
		}

		this.totalRetries++
	}

	/**
	 * Record a successful request (resets the quiet-window timer but not counters).
	 * Individual category counters are preserved so the total session budget
	 * remains accurate; the quiet-window mechanism handles organic reset.
	 */
	recordSuccess(): void {
		// Update lastErrorTime to "now" so the quiet window resets from this point.
		// This means if errors resume after a long success streak, the counters
		// will have been auto-reset by maybeResetOnQuietWindow().
		this.lastErrorTime = Date.now()
	}

	/**
	 * Get retry statistics for diagnostics/telemetry.
	 */
	getStats(): {
		totalRetries: number
		records: Map<string, RetryRecord>
		isExhausted: boolean
	} {
		return {
			totalRetries: this.totalRetries,
			records: new Map(this.records),
			isExhausted: this.totalRetries >= this.config.maxTotalRetries,
		}
	}

	/**
	 * Reset all retry state (e.g., for a new conversation).
	 */
	reset(): void {
		this.records.clear()
		this.totalRetries = 0
		this.lastErrorTime = 0
	}

	// ── Private helpers ──────────────────────────────────────────────────

	/**
	 * If enough time has elapsed since the last error (resetWindowMs),
	 * automatically reset all counters. This prevents stale retry state
	 * from blocking retries after transient issues have resolved.
	 */
	private maybeResetOnQuietWindow(): void {
		if (this.lastErrorTime === 0) {
			return
		}
		const elapsed = Date.now() - this.lastErrorTime
		if (elapsed >= this.config.resetWindowMs) {
			this.reset()
		}
	}
}
