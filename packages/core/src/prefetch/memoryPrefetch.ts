/**
 * Memory/Attachment Prefetch
 *
 * Prefetches relevant memory and attachments based on message context
 * to reduce latency in the main agent loop.
 */

export interface MemoryPrefetchResult {
	memories: string[] // Relevant memory content
	fetchedAt: number // Timestamp
	fromCache: boolean // Whether result came from cache
}

export class MemoryPrefetcher {
	private cache: MemoryPrefetchResult | null = null
	private pendingFetch: Promise<MemoryPrefetchResult> | null = null
	private readonly cacheTtlMs: number = 60_000 // 1 minute

	/**
	 * Start prefetching memories (non-blocking).
	 * Returns a promise that resolves with the results.
	 */
	startPrefetch(fetchFn: () => Promise<string[]>): Promise<MemoryPrefetchResult> {
		// If cache is still valid, return immediately
		if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
			return Promise.resolve(this.cache)
		}

		// If already fetching, return the pending promise
		if (this.pendingFetch) {
			return this.pendingFetch
		}

		// Start new fetch
		this.pendingFetch = this.doFetch(fetchFn)
		return this.pendingFetch
	}

	/**
	 * Get cached result immediately (non-blocking).
	 * Returns null if no cached result available.
	 */
	getCached(): MemoryPrefetchResult | null {
		if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
			return this.cache
		}
		return null
	}

	/**
	 * Wait for prefetch result with timeout.
	 */
	async getWithTimeout(timeoutMs: number = 3000): Promise<MemoryPrefetchResult | null> {
		if (!this.pendingFetch) {
			return this.getCached()
		}

		try {
			const result = await Promise.race([
				this.pendingFetch,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
			])
			return result
		} catch {
			return this.getCached()
		}
	}

	invalidateCache(): void {
		this.cache = null
	}

	private async doFetch(fetchFn: () => Promise<string[]>): Promise<MemoryPrefetchResult> {
		try {
			const memories = await fetchFn()
			const result: MemoryPrefetchResult = {
				memories,
				fetchedAt: Date.now(),
				fromCache: false,
			}
			this.cache = result
			return result
		} finally {
			this.pendingFetch = null
		}
	}
}

export const globalMemoryPrefetcher = new MemoryPrefetcher()
