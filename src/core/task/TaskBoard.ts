import * as fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"
import { z } from "zod"

// ────────────────────────────── Types ──────────────────────────────

export interface TaskBoardItem {
	id: string
	title: string
	description?: string
	status: "pending" | "in_progress" | "completed" | "failed"
	priority: "high" | "medium" | "low"
	dependsOn?: string[]
	createdAt: number
	updatedAt: number
	metadata?: Record<string, unknown>
}

export interface CreateTaskParams {
	title: string
	description?: string
	priority?: TaskBoardItem["priority"]
	dependsOn?: string[]
	metadata?: Record<string, unknown>
}

export interface TaskFilter {
	status?: TaskBoardItem["status"]
	priority?: TaskBoardItem["priority"]
	limit?: number
}

const taskBoardItemSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	description: z.string().optional(),
	status: z.enum(["pending", "in_progress", "completed", "failed"]),
	priority: z.enum(["high", "medium", "low"]),
	dependsOn: z.array(z.string()).optional(),
	createdAt: z.number(),
	updatedAt: z.number(),
	metadata: z.record(z.unknown()).optional(),
})

const persistedTaskBoardSchema = z.array(z.unknown())

// ────────────────────────────── TaskBoard ──────────────────────────────

/**
 * Lightweight task board with JSON file persistence.
 *
 * Storage location: `{cwd}/.roo/tasks/{sessionId}.json`
 *
 * - Every write operation triggers an automatic save.
 * - Uses an in-process write lock to serialize mutations (no external lockfile).
 * - Task IDs are generated via `crypto.randomUUID()`.
 */
export class TaskBoard {
	private readonly filePath: string
	private tasks: Map<string, TaskBoardItem> = new Map()
	private writeLock: Promise<void> = Promise.resolve()
	private loaded = false

	constructor(cwd: string, sessionId: string) {
		this.filePath = path.join(cwd, ".roo", "tasks", `${sessionId}.json`)
	}

	// ────────────────────────────── CRUD ──────────────────────────────

	/**
	 * Create a new task and persist it.
	 */
	async createTask(params: CreateTaskParams): Promise<TaskBoardItem> {
		return this.withLock(async () => {
			await this.ensureLoaded()

			const now = Date.now()
			const item: TaskBoardItem = {
				id: crypto.randomUUID(),
				title: params.title,
				description: params.description,
				status: "pending",
				priority: params.priority ?? "medium",
				dependsOn: params.dependsOn,
				createdAt: now,
				updatedAt: now,
				metadata: params.metadata,
			}

			this.tasks.set(item.id, item)
			await this.save()
			return item
		})
	}

	/**
	 * Update an existing task. Throws if the task does not exist.
	 */
	async updateTask(
		taskId: string,
		updates: Partial<Pick<TaskBoardItem, "title" | "description" | "status" | "priority" | "dependsOn" | "metadata">>,
	): Promise<TaskBoardItem> {
		return this.withLock(async () => {
			await this.ensureLoaded()

			const existing = this.tasks.get(taskId)
			if (!existing) {
				throw new Error(`Task not found: ${taskId}`)
			}

			const updated: TaskBoardItem = {
				...existing,
				...updates,
				id: existing.id, // prevent id override
				createdAt: existing.createdAt, // prevent createdAt override
				updatedAt: Date.now(),
			}

			this.tasks.set(taskId, updated)
			await this.save()
			return updated
		})
	}

	/**
	 * Get a single task by ID.
	 */
	async getTask(taskId: string): Promise<TaskBoardItem | undefined> {
		return this.withLock(async () => {
			await this.ensureLoaded()
			return this.tasks.get(taskId)
		})
	}

	/**
	 * List tasks with optional filtering by status, priority, and limit.
	 * Results are sorted by updatedAt descending (newest first).
	 */
	async listTasks(filter?: TaskFilter): Promise<TaskBoardItem[]> {
		return this.withLock(async () => {
			await this.ensureLoaded()

			let items = Array.from(this.tasks.values())

			if (filter?.status) {
				items = items.filter((t) => t.status === filter.status)
			}
			if (filter?.priority) {
				items = items.filter((t) => t.priority === filter.priority)
			}

			// Sort by updatedAt descending
			items.sort((a, b) => b.updatedAt - a.updatedAt)

			if (filter?.limit && filter.limit > 0) {
				items = items.slice(0, filter.limit)
			}

			return items
		})
	}

	/**
	 * Delete a task by ID. Returns true if it existed and was removed.
	 */
	async deleteTask(taskId: string): Promise<boolean> {
		return this.withLock(async () => {
			await this.ensureLoaded()

			const deleted = this.tasks.delete(taskId)
			if (deleted) {
				await this.save()
			}
			return deleted
		})
	}

	// ────────────────────────────── Dependency helpers ──────────────────────────────

	/**
	 * Check whether a task is blocked (i.e. has unfinished dependencies).
	 */
	isBlocked(taskId: string): boolean {
		return this.getBlockedBy(taskId).length > 0
	}

	/**
	 * Return the IDs of incomplete dependencies that are blocking `taskId`.
	 */
	getBlockedBy(taskId: string): string[] {
		const task = this.tasks.get(taskId)
		if (!task?.dependsOn || task.dependsOn.length === 0) {
			return []
		}

		return task.dependsOn.filter((depId) => {
			const dep = this.tasks.get(depId)
			// A dependency blocks if it exists and is not completed
			return dep !== undefined && dep.status !== "completed"
		})
	}

	// ────────────────────────────── Private: persistence ──────────────────────────────

	/**
	 * Persist the full task map to disk as a JSON array.
	 */
	private async save(): Promise<void> {
		const dir = path.dirname(this.filePath)
		await fs.mkdir(dir, { recursive: true })

		const items = Array.from(this.tasks.values())
		const json = JSON.stringify(items, null, 2)
		await fs.writeFile(this.filePath, json, "utf8")
	}

	/**
	 * Load task data from disk into memory.
	 */
	private async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8")
			const persistedItems = persistedTaskBoardSchema.parse(JSON.parse(raw))

			this.tasks.clear()
			for (const item of persistedItems) {
				const parsed = taskBoardItemSchema.safeParse(item)
				if (parsed.success) {
					this.tasks.set(parsed.data.id, parsed.data)
				}
			}
		} catch {
			// File doesn't exist or is corrupted — start with empty map
			this.tasks.clear()
		}

		this.loaded = true
	}

	/**
	 * Ensure data is loaded from disk before first read/write.
	 */
	private async ensureLoaded(): Promise<void> {
		if (!this.loaded) {
			await this.load()
		}
	}

	// ────────────────────────────── Private: write lock ──────────────────────────────

	/**
	 * Serialize write operations within this process to prevent interleaving.
	 */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}
}
