/**
 * Global API request timing utilities.
 *
 * Extracted from Task.ts to avoid circular dependencies.
 * Used by TaskExecutor and TaskStreamProcessor.
 */

/**
 * Timestamp of the last global API request.
 * Used for rate limiting across all tasks.
 */
let lastGlobalApiRequestTime: number | undefined

/**
 * Get the last global API request timestamp.
 */
export function getLastGlobalApiRequestTime(): number | undefined {
	return lastGlobalApiRequestTime
}

/**
 * Set the last global API request timestamp.
 */
export function setLastGlobalApiRequestTime(time: number | undefined): void {
	lastGlobalApiRequestTime = time
}
