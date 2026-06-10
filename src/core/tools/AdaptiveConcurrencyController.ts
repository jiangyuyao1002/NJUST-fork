import { classifyToolCategory, type ToolExecutionStats, type ToolCategory } from "../task/ToolExecutionOrchestrator"

export interface ConcurrencyLimits {
	read: number
	write: number
	mcp: number
	bash: number
	default: number
}

export type ConcurrencyStatus = Record<ToolCategory, { active: number; limit: number; waiting: number }>
export type ConcurrencyTuningEvent = {
	category: ToolCategory
	previousLimit: number
	nextLimit: number
	reason: "increase" | "decrease"
}

type Waiter = { resolve: () => void }

type WaitQueue = {
	items: Waiter[]
	head: number
}

const DEFAULT_LIMITS: ConcurrencyLimits = { read: 20, write: 3, mcp: 5, bash: 2, default: 10 }

export class AdaptiveConcurrencyController {
	private readonly initialLimits: ConcurrencyLimits
	private readonly limits: ConcurrencyLimits
	private readonly active: ConcurrencyLimits
	private readonly queues: Record<ToolCategory, WaitQueue> = {
		read: { items: [], head: 0 },
		write: { items: [], head: 0 },
		mcp: { items: [], head: 0 },
		bash: { items: [], head: 0 },
		default: { items: [], head: 0 },
	}
	private autoTuningEnabled = false
	private autoTuningStats?: ToolExecutionStats
	private autoTuneInterval = 20
	private operationsSinceTune = 0
	private tuningListener?: (event: ConcurrencyTuningEvent) => void

	constructor(limits: Partial<ConcurrencyLimits> = {}, tuningListener?: (event: ConcurrencyTuningEvent) => void) {
		this.initialLimits = { ...DEFAULT_LIMITS, ...limits }
		this.limits = { ...this.initialLimits }
		this.active = { read: 0, write: 0, mcp: 0, bash: 0, default: 0 }
		this.tuningListener = tuningListener
	}

	async acquire(category: ToolCategory): Promise<void> {
		if (this.active[category] < this.limits[category] && this.getQueueLength(category) === 0) {
			this.active[category]++
			return
		}
		await new Promise<void>((resolve) => this.enqueue(category, { resolve }))
		this.active[category]++
	}

	release(category: ToolCategory): void {
		this.active[category] = Math.max(0, this.active[category] - 1)
		this.drain(category)
	}

	getAvailableSlots(category: ToolCategory): number {
		return Math.max(0, this.limits[category] - this.active[category])
	}

	getQueuedCount(category: ToolCategory): number {
		return this.getQueueLength(category)
	}

	adjustLimit(category: ToolCategory, newLimit: number): void {
		this.limits[category] = Math.max(1, this.capLimit(category, Math.floor(newLimit)))
		this.drain(category)
	}

	getEffectiveMaxConcurrency(): number {
		return Math.max(1, Math.min(...Object.values(this.limits)))
	}

	getActiveCount(category: ToolCategory): number {
		return this.active[category]
	}

	getStatus(): ConcurrencyStatus {
		return {
			read: this.status("read"),
			write: this.status("write"),
			mcp: this.status("mcp"),
			bash: this.status("bash"),
			default: this.status("default"),
		}
	}

	reset(): void {
		this.disableAutoTuning()
		this.limits.read = this.initialLimits.read
		this.limits.write = this.initialLimits.write
		this.limits.mcp = this.initialLimits.mcp
		this.limits.bash = this.initialLimits.bash
		this.limits.default = this.initialLimits.default
		this.active.read = this.active.write = this.active.mcp = this.active.bash = this.active.default = 0
		for (const category of ["read", "write", "mcp", "bash", "default"] as ToolCategory[]) this.clearQueue(category)
	}

	enableAutoTuning(stats: ToolExecutionStats, interval = 20): void {
		this.autoTuningEnabled = true
		this.autoTuningStats = stats
		this.autoTuneInterval = Math.max(1, interval)
		this.operationsSinceTune = 0
	}

	disableAutoTuning(): void {
		this.autoTuningEnabled = false
		this.autoTuningStats = undefined
		this.operationsSinceTune = 0
	}

	tune(stats: ToolExecutionStats): void {
		for (const category of ["read", "write", "mcp", "bash", "default"] as ToolCategory[]) {
			const items = [...stats.getAll().entries()]
				.filter(([toolName]) => this.categoryOfTool(toolName) === category)
				.map(([, data]) => data)
			if (items.length === 0) continue
			const count = items.reduce((n, d) => n + d.count, 0)
			const avgMs = items.reduce((n, d) => n + d.avgMs * d.count, 0) / count
			const failureRate = items.reduce((n, d) => n + d.failureRate * d.count, 0) / count
			const current = this.limits[category]
			if (avgMs > 2000 && failureRate > 0.15) this.setTunedLimit(category, current - 1, "decrease")
			else if (avgMs < 500 && failureRate < 0.05) this.setTunedLimit(category, current + 1, "increase")
		}
	}

	private setTunedLimit(category: ToolCategory, requested: number, reason: "increase" | "decrease"): void {
		const next = this.capLimit(category, requested)
		if (next === this.limits[category]) return
		const previousLimit = this.limits[category]
		this.limits[category] = Math.max(next, this.active[category])
		this.tuningListener?.({ category, previousLimit, nextLimit: this.limits[category], reason })
		this.drain(category)
	}

	private capLimit(category: ToolCategory, limit: number): number {
		const upper = category === "write" ? 5 : category === "bash" ? 4 : this.initialLimits[category] * 2
		return Math.max(1, Math.min(limit, upper))
	}

	private status(category: ToolCategory) {
		return { active: this.active[category], limit: this.limits[category], waiting: this.getQueueLength(category) }
	}

	private categoryOfTool(toolName: string): ToolCategory {
		return classifyToolCategory(toolName, false)
	}

	private enqueue(category: ToolCategory, waiter: Waiter): void {
		this.queues[category].items.push(waiter)
	}

	private clearQueue(category: ToolCategory): void {
		// Clear without resolving — prevents active[category] overcount
		// from concurrent resolves after reset().
		const queue = this.queues[category]
		queue.items = []
		queue.head = 0
	}

	private getQueueLength(category: ToolCategory): number {
		const queue = this.queues[category]
		return queue.items.length - queue.head
	}

	private drain(category: ToolCategory): void {
		const queue = this.queues[category]
		while (queue.head < queue.items.length && this.active[category] < this.limits[category]) {
			const waiter = queue.items[queue.head++]
			if (!waiter) continue
			waiter.resolve()
		}

		if (queue.head > 32 && queue.head * 2 > queue.items.length) {
			queue.items = queue.items.slice(queue.head)
			queue.head = 0
		}
	}
}
