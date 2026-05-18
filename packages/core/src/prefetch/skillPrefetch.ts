/**
 * Skill Discovery Prefetch
 *
 * Prefetches available skills in parallel with the main agent loop
 * to reduce latency when skills are needed.
 */

export interface SkillPrefetchResult {
	skills: string[] // Available skill names/IDs
	fetchedAt: number // Timestamp
	fromCache: boolean // Whether result came from cache
}

export class SkillPrefetcher {
	private cache: SkillPrefetchResult | null = null
	private pendingFetch: Promise<SkillPrefetchResult> | null = null
	private readonly cacheTtlMs: number = 30_000 // 30 seconds

	/**
	 * Start prefetching skills (non-blocking).
	 * Returns a promise that resolves with the results.
	 */
	startPrefetch(fetchFn: () => Promise<string[]>): Promise<SkillPrefetchResult> {
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
	getCached(): SkillPrefetchResult | null {
		if (this.cache && Date.now() - this.cache.fetchedAt < this.cacheTtlMs) {
			return this.cache
		}
		return null
	}

	/**
	 * Wait for prefetch result with timeout.
	 */
	async getWithTimeout(timeoutMs: number = 3000): Promise<SkillPrefetchResult | null> {
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

	private async doFetch(fetchFn: () => Promise<string[]>): Promise<SkillPrefetchResult> {
		try {
			const skills = await fetchFn()
			const result: SkillPrefetchResult = {
				skills,
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

export const globalSkillPrefetcher = new SkillPrefetcher()
