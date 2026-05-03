/**
 * Task stack helpers (in-memory LIFO) for tests and future refactors.
 *
 * Runtime open tasks live in `ClineProvider`’s `clineStack`; mutate only via
 * `addClineToStack` / `removeClineFromStack` / `rehydrateCurrentTaskInPlace` (see
 * `docs/task-planning-readthrough.md` stack audit section).
 *
 * Not the same as `core/webview/TaskCenter.ts` (extracted stack module draft, not wired to `clineStack` yet).
 */

import type { TaskLike } from "@njust-ai-cj/types"

// ── Stack types ──────────────────────────────────────────────────────

export interface TaskStackEntry {
	taskId: string
	parentTaskId?: string
	task: TaskLike
}

// ── Stack helper ─────────────────────────────────────────────────────

/**
 * Lightweight task stack. Supports push, pop, peek, and ancestry queries
 * without coupling to ClineProvider internals.
 */
export class TaskStack {
	private readonly entries: TaskStackEntry[] = []

	get size(): number {
		return this.entries.length
	}

	get current(): TaskStackEntry | undefined {
		return this.entries[this.entries.length - 1]
	}

	push(entry: TaskStackEntry): void {
		this.entries.push(entry)
	}

	pop(): TaskStackEntry | undefined {
		return this.entries.pop()
	}

	peek(): TaskStackEntry | undefined {
		return this.entries[this.entries.length - 1]
	}

	findById(taskId: string): TaskStackEntry | undefined {
		return this.entries.find((e) => e.taskId === taskId)
	}

	/** Return IDs from bottom (root) to top (current). */
	ancestryIds(): string[] {
		return this.entries.map((e) => e.taskId)
	}

	clear(): void {
		this.entries.length = 0
	}

	toArray(): readonly TaskStackEntry[] {
		return [...this.entries]
	}
}
