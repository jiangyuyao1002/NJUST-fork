/**
 * ToolExecutionOrchestrator — Coordinates tool execution scheduling, ordering,
 * and resource management.
 *
 * Extracted from Task.ts to decompose the monolithic file.
 * Encapsulates tool execution ordering, read/write lock semantics,
 * and adaptive concurrency control.
 *
 * Phase 1: Standalone utilities that can be imported by Task.ts and
 * ConcurrentToolExecutor.ts. Full extraction of tool dispatch logic
 * from Task.ts is deferred to Phase 2.
 */

// ─── Tool Category Classification ────────────────────────────────────────────

export type ToolCategory = "read" | "write" | "mcp" | "bash" | "default"

/**
 * Classify a tool name into a category for concurrency and scheduling decisions.
 * Write tools modify state and need serialization; read tools can run in parallel.
 */
export function classifyToolCategory(toolName: string, requiresCheckpoint: boolean): ToolCategory {
	if (requiresCheckpoint) return "write"

	const name = toolName.toLowerCase()

	// MCP tools
	if (name.startsWith("mcp_") || name.includes("mcp")) return "mcp"

	// Shell/bash tools
	if (name === "execute_command" || name === "bash" || name === "command") return "bash"

	// Write tools (explicit list)
	const writeTools = new Set([
		"write_to_file",
		"apply_diff",
		"insert_content",
		"search_and_replace",
		"delete_file",
		"rename_file",
		"new_task",
	])
	if (writeTools.has(name)) return "write"

	// Default to read
	return "read"
}

// ─── Read-Write Lock ─────────────────────────────────────────────────────────

/**
 * ToolExecutionScheduler — A readers-writer lock for tool execution.
 *
 * Prevents read-write and write-write conflicts by serializing write tools
 * while allowing concurrent read tools. This avoids race conditions when
 * multiple tools are executed in parallel.
 *
 * Usage:
 *   await scheduler.acquire(toolCategory)
 *   try { ... execute tool ... }
 *   finally { scheduler.release(toolCategory) }
 */
export class ToolExecutionScheduler {
	private writeLock = false
	private readCount = 0
	private waitQueue: Array<() => void> = []

	/**
	 * Acquire the appropriate lock for a tool category.
	 * Write tools get exclusive access; read tools can run concurrently
	 * but must wait if a write is in progress.
	 */
	async acquire(category: ToolCategory): Promise<void> {
		const isWrite = category === "write"

		if (isWrite) {
			// Write tools need exclusive access
			while (this.writeLock || this.readCount > 0) {
				await new Promise<void>((resolve) => this.waitQueue.push(resolve))
			}
			this.writeLock = true
		} else {
			// Read/MCP/Bash tools can run concurrently but wait for writes
			while (this.writeLock) {
				await new Promise<void>((resolve) => this.waitQueue.push(resolve))
			}
			this.readCount++
		}
	}

	/**
	 * Release the lock held for a tool category.
	 */
	release(category: ToolCategory): void {
		const isWrite = category === "write"

		if (isWrite) {
			this.writeLock = false
		} else {
			this.readCount = Math.max(0, this.readCount - 1)
		}

		// Wake up all waiters — they'll re-check conditions
		this.drainWaitQueue()
	}

	/**
	 * Get current lock status for diagnostics.
	 */
	getStatus(): { writeLocked: boolean; activeReaders: number; waitingCount: number } {
		return {
			writeLocked: this.writeLock,
			activeReaders: this.readCount,
			waitingCount: this.waitQueue.length,
		}
	}

	private drainWaitQueue(): void {
		// Wake all waiters so readers can enter concurrently.
		// JS's single-threaded event loop makes this safe: each
		// waiter re-checks its while-loop condition in acquire()
		// and re-queues itself if it still cannot proceed.
		while (this.waitQueue.length > 0) {
			this.waitQueue.shift()!()
		}
	}
}

// ─── Tool Execution Priority Queue ──────────────────────────────────────────

export interface ToolExecutionItem {
	toolName: string
	category: ToolCategory
	index: number
	priority: number
}

/**
 * Prioritizes tool execution order:
 * 1. Read tools first (fast, non-blocking)
 * 2. MCP tools second (external, may be slow)
 * 3. Bash tools third (side effects)
 * 4. Write tools last (need exclusive access)
 */
export function prioritizeTools(tools: Array<{ name: string; requiresCheckpoint: boolean }>): ToolExecutionItem[] {
	const priorityMap: Record<ToolCategory, number> = {
		read: 0,
		mcp: 1,
		bash: 2,
		write: 3,
		default: 1,
	}

	return tools
		.map((tool, index) => {
			const category = classifyToolCategory(tool.name, tool.requiresCheckpoint)
			return {
				toolName: tool.name,
				category,
				index,
				priority: priorityMap[category],
			}
		})
		.sort((a, b) => a.priority - b.priority)
}

// ─── Tool Execution Statistics ───────────────────────────────────────────────

/**
 * Tracks per-tool execution statistics for adaptive behavior.
 */
export class ToolExecutionStats {
	private stats = new Map<string, { count: number; totalMs: number; failures: number }>()

	record(toolName: string, durationMs: number, failed: boolean = false): void {
		let entry = this.stats.get(toolName)
		if (!entry) {
			entry = { count: 0, totalMs: 0, failures: 0 }
			this.stats.set(toolName, entry)
		}
		entry.count++
		entry.totalMs += durationMs
		if (failed) {
			entry.failures++
		}
	}

	getAverageDuration(toolName: string): number {
		const entry = this.stats.get(toolName)
		if (!entry || entry.count === 0) return 0
		return entry.totalMs / entry.count
	}

	getFailureRate(toolName: string): number {
		const entry = this.stats.get(toolName)
		if (!entry || entry.count === 0) return 0
		return entry.failures / entry.count
	}

	getAll(): Map<string, { count: number; avgMs: number; failureRate: number }> {
		const result = new Map<string, { count: number; avgMs: number; failureRate: number }>()
		for (const [name, data] of this.stats) {
			result.set(name, {
				count: data.count,
				avgMs: data.count > 0 ? data.totalMs / data.count : 0,
				failureRate: data.count > 0 ? data.failures / data.count : 0,
			})
		}
		return result
	}

	reset(): void {
		this.stats.clear()
	}
}
