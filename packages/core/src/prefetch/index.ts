/**
 * Prefetch coordination module.
 * Starts all prefetch operations in parallel at the beginning of each agent loop turn.
 */

import { globalSkillPrefetcher } from "./skillPrefetch.js"
import { globalMemoryPrefetcher } from "./memoryPrefetch.js"

export { globalSkillPrefetcher, SkillPrefetcher } from "./skillPrefetch.js"
export type { SkillPrefetchResult } from "./skillPrefetch.js"
export { globalMemoryPrefetcher, MemoryPrefetcher } from "./memoryPrefetch.js"
export type { MemoryPrefetchResult } from "./memoryPrefetch.js"

/**
 * Start all prefetch operations in parallel.
 * Call this at the beginning of each agent loop iteration.
 */
export function startAllPrefetch(options: {
	skillFetchFn?: () => Promise<string[]>
	memoryFetchFn?: () => Promise<string[]>
}): void {
	if (options.skillFetchFn) {
		void globalSkillPrefetcher.startPrefetch(options.skillFetchFn)
	}
	if (options.memoryFetchFn) {
		void globalMemoryPrefetcher.startPrefetch(options.memoryFetchFn)
	}
}
