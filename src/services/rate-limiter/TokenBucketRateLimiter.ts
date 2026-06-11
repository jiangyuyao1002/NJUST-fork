/**
 * Token Bucket Rate Limiter
 *
 * Implements a standard token bucket algorithm for proactive rate limiting.
 * Each provider gets its own bucket with configurable capacity and refill rate.
 * Multiple concurrent tasks share the same bucket, ensuring coordinated throttling.
 *
 * Usage:
 *   const limiter = TokenBucketRateLimiter.getInstance()
 *   await limiter.wait("anthropic")  // waits if bucket is empty
 */

interface BucketConfig {
	capacity: number // max tokens the bucket can hold
	refillPerSec: number // tokens added per second
}

interface BucketState {
	tokens: number
	lastRefill: number // timestamp of last refill
	waiting: Array<{ resolve: () => void; createdAt: number }>
}

const DEFAULT_CONFIGS: Record<string, BucketConfig> = {
	anthropic: { capacity: 10, refillPerSec: 0.5 }, // ~30 RPM
	openai: { capacity: 20, refillPerSec: 1.0 }, // ~60 RPM
	bedrock: { capacity: 20, refillPerSec: 1.0 },
	gemini: { capacity: 30, refillPerSec: 1.5 }, // ~90 RPM
	openrouter: { capacity: 15, refillPerSec: 0.75 },
	mistral: { capacity: 15, refillPerSec: 0.75 },
	deepseek: { capacity: 15, refillPerSec: 0.75 },
	aws: { capacity: 20, refillPerSec: 1.0 },
	vertex: { capacity: 20, refillPerSec: 1.0 },
	default: { capacity: 10, refillPerSec: 0.5 },
}

export class TokenBucketRateLimiter {
	private static _instance: TokenBucketRateLimiter
	private buckets = new Map<string, BucketState>()
	private configs: Record<string, BucketConfig>
	// Per-provider refill timers. Previously this was a single field, which
	// caused a later-scheduled provider's timer to clearTimeout() an earlier
	// provider's pending timer.
	private refillTimers = new Map<string, ReturnType<typeof setTimeout>>()
	// Per-provider async mutex to prevent TOCTOU race conditions on token
	// consumption across concurrent wait() calls.
	// Each entry stores { promise, release } so reset() can resolve pending
	// waiters instead of abandoning them (which would cause permanent hangs).
	private locks = new Map<string, { promise: Promise<void>; release: () => void }>()

	constructor(customConfigs?: Record<string, Partial<BucketConfig>>) {
		this.configs = { ...DEFAULT_CONFIGS }
		if (customConfigs) {
			for (const [key, cfg] of Object.entries(customConfigs)) {
				if (this.configs[key]) {
					this.configs[key] = { ...this.configs[key], ...cfg }
				} else {
					this.configs[key] = { capacity: 10, refillPerSec: 0.5, ...cfg }
				}
			}
		}
	}

	static getInstance(): TokenBucketRateLimiter {
		if (!TokenBucketRateLimiter._instance) {
			TokenBucketRateLimiter._instance = new TokenBucketRateLimiter()
		}
		return TokenBucketRateLimiter._instance
	}

	static resetInstance(): void {
		if (TokenBucketRateLimiter._instance) {
			TokenBucketRateLimiter._instance.dispose()
		}
		TokenBucketRateLimiter._instance = undefined as UnsafeAny
	}

	private getConfig(key: string): BucketConfig {
		return this.configs[key] ?? this.configs.default!
	}

	private getBucket(key: string): BucketState {
		let bucket = this.buckets.get(key)
		if (!bucket) {
			const cfg = this.getConfig(key)
			bucket = { tokens: cfg.capacity, lastRefill: Date.now(), waiting: [] }
			this.buckets.set(key, bucket)
		}
		return bucket
	}

	/**
	 * Acquire an async mutex for the given provider. Returns a release function
	 * that MUST be called (preferably in a finally block) to avoid deadlocks.
	 */
	private async acquireLock(provider: string): Promise<() => void> {
		while (true) {
			const existing = this.locks.get(provider)
			if (!existing) break
			await existing.promise
		}

		let release!: () => void
		const promise = new Promise<void>((resolve) => {
			release = () => {
				this.locks.delete(provider)
				resolve()
			}
		})
		this.locks.set(provider, { promise, release })
		return release
	}

	private refill(bucket: BucketState, cfg: BucketConfig): void {
		const now = Date.now()
		const elapsed = (now - bucket.lastRefill) / 1000
		if (elapsed <= 0) return
		const add = elapsed * cfg.refillPerSec
		bucket.tokens = Math.min(bucket.tokens + add, cfg.capacity)
		bucket.lastRefill = now
	}

	/**
	 * Try to consume a token. Returns true if allowed, false if rate limited.
	 *
	 * Note: This is a best-effort synchronous check. Under high concurrency,
	 * use wait() for coordinated throttling.
	 */
	tryConsume(provider: string): boolean {
		const cfg = this.getConfig(provider)
		const bucket = this.getBucket(provider)
		this.refill(bucket, cfg)

		if (bucket.tokens >= 1) {
			bucket.tokens -= 1
			return true
		}
		return false
	}

	/**
	 * Wait until a token is available. Resolves as soon as possible.
	 * Returns the wait time in milliseconds (0 if no wait was needed).
	 *
	 * Uses a per-provider async mutex to prevent TOCTOU race conditions
	 * where concurrent calls both see tokens >= 1 and decrement below zero.
	 */
	async wait(provider: string): Promise<number> {
		const release = await this.acquireLock(provider)
		try {
			const cfg = this.getConfig(provider)
			const bucket = this.getBucket(provider)
			this.refill(bucket, cfg)

			if (bucket.tokens >= 1) {
				bucket.tokens -= 1
				return 0
			}

			// Queue: estimate wait time from refill rate.
			// The lock is released AFTER enqueuing the waiter (in the finally
			// block below). The waiter resolves later in scheduleRefill which
			// acquires its own lock — this is intentional: the mutex protects
			// bucket state (check + enqueue), not the asynchronous wait itself.
			return new Promise<number>((resolve) => {
				const createdAt = Date.now()
				bucket.waiting.push({ resolve: () => resolve(Date.now() - createdAt), createdAt })
				this.scheduleRefill(provider)
			})
		} finally {
			release()
		}
	}

	private scheduleRefill(provider: string): void {
		const bucket = this.buckets.get(provider)
		if (!bucket || bucket.waiting.length === 0) return

		const cfg = this.getConfig(provider)
		const waitMs = Math.ceil(1000 / cfg.refillPerSec)

		// Clear any pending timer for THIS provider only — other providers'
		// timers must be preserved.
		const existing = this.refillTimers.get(provider)
		if (existing) {
			clearTimeout(existing)
		}

		const timer = setTimeout(() => {
			this.refillTimers.delete(provider)
			const b = this.buckets.get(provider)
			if (!b || b.waiting.length === 0)
				return // Wrap async work in an immediately-invoked async IIFE so that
				// any exception is caught rather than becoming an unhandled
				// rejection (setTimeout does not propagate async errors).
			;(async () => {
				const release = await this.acquireLock(provider)
				const toResolve: Array<() => void> = []
				try {
					this.refill(b, cfg)
					while (b.tokens >= 1 && b.waiting.length > 0) {
						const next = b.waiting.shift()
						if (next) {
							b.tokens -= 1
							toResolve.push(next.resolve)
						}
					}
				} finally {
					release()
				}

				// Resolve waiters OUTSIDE the lock so that the .then() callbacks
				// triggered by resolve() don't run while the lock is still held.
				for (const fn of toResolve) {
					fn()
				}

				// If still waiting, schedule next refill
				if (b.waiting.length > 0) {
					this.scheduleRefill(provider)
				}
			})().catch((err: unknown) => {
				// eslint-disable-next-line no-console
				console.error(`[TokenBucketRateLimiter] refill timer error for "${provider}":`, err)
			})
		}, waitMs)
		this.refillTimers.set(provider, timer)
	}

	/**
	 * Drain all tokens from a provider's bucket (back to zero).
	 * Used after receiving a 429 to enforce the backoff.
	 */
	async drain(provider: string): Promise<void> {
		const release = await this.acquireLock(provider)
		try {
			const bucket = this.buckets.get(provider)
			if (bucket) {
				bucket.tokens = 0
			}
		} finally {
			release()
		}
	}

	/**
	 * Override the rate limit config for a provider at runtime.
	 */
	setConfig(provider: string, config: Partial<BucketConfig>): void {
		const existing = this.configs[provider] ?? this.configs.default!
		this.configs[provider] = { ...existing, ...config }
	}

	/**
	 * Get current stats for a provider (for monitoring).
	 */
	getStats(provider: string): { tokens: number; waiting: number; capacity: number; refillPerSec: number } | null {
		const bucket = this.buckets.get(provider)
		if (!bucket) return null
		const cfg = this.getConfig(provider)
		return {
			tokens: bucket.tokens,
			waiting: bucket.waiting.length,
			capacity: cfg.capacity,
			refillPerSec: cfg.refillPerSec,
		}
	}

	/** Reset all buckets (for testing / dispose). */
	reset(): void {
		this.buckets.clear()
		for (const timer of this.refillTimers.values()) {
			clearTimeout(timer)
		}
		this.refillTimers.clear()
		// Resolve all pending locks to prevent waiters from hanging forever.
		// After release the lock entry is deleted from the map, so we snapshot
		// keys first to avoid concurrent modification.
		for (const [, entry] of [...this.locks]) {
			entry.release()
		}
		this.locks.clear()
	}

	/** Dispose the limiter and clear any pending timers. */
	dispose(): void {
		this.reset()
	}
}
