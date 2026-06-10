/**
 * MemoryStore — Persistent memory storage with TTL expiry.
 *
 * Extends the existing session memory system with:
 * - Memory type classification (session / user_feedback / project / reference)
 * - TTL-based expiry (time-based, in addition to count-based pruning)
 * - File-level operations (load, save, delete, prune expired)
 */

import * as fs from "fs/promises"
import * as path from "path"
import { SESSION_MEMORIES_DIR } from "../../core/condense/sessionMemoryCompact"

export type MemoryType = "session" | "user_feedback" | "project" | "reference"

/** TTL configuration per memory type (in milliseconds). */
export const MEMORY_TTL: Record<MemoryType, number> = {
	session: 7 * 24 * 60 * 60 * 1000, // 7 days
	user_feedback: 7 * 24 * 60 * 60 * 1000, // 7 days
	project: 30 * 24 * 60 * 60 * 1000, // 30 days
	reference: 90 * 24 * 60 * 60 * 1000, // 90 days
}

export interface MemoryEntry {
	id: string
	type: MemoryType
	timestamp: number
	content: string
	tags?: string[]
	source?: string
}

/**
 * Load all non-expired memory entries of a given type from disk.
 */
export async function loadMemories(workspaceDir: string, type?: MemoryType): Promise<MemoryEntry[]> {
	const dir = path.join(workspaceDir, SESSION_MEMORIES_DIR)
	try {
		const files = await fs.readdir(dir)
		const jsonFiles = files.filter((f) => f.startsWith("memory-") && f.endsWith(".json"))

		const entries: MemoryEntry[] = []
		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(dir, file), "utf-8")
				const parsed = JSON.parse(content) as MemoryEntry
				// Filter by type if specified
				if (type && parsed.type !== type) continue
				// Filter expired entries
				const ttl = MEMORY_TTL[parsed.type] ?? MEMORY_TTL.session
				if (Date.now() - parsed.timestamp > ttl) {
					// Remove expired file silently
					fs.unlink(path.join(dir, file)).catch(() => {
						/* best-effort cleanup */
					})
					continue
				}
				entries.push(parsed)
			} catch {
				// intentionally ignored: skip corrupted files
			}
		}

		return entries.sort((a, b) => b.timestamp - a.timestamp)
	} catch {
		// intentionally ignored: memory directory read failure
		return []
	}
}

/**
 * Save a memory entry to disk.
 */
export async function saveMemory(entry: MemoryEntry, workspaceDir: string): Promise<void> {
	const dir = path.join(workspaceDir, SESSION_MEMORIES_DIR)
	await fs.mkdir(dir, { recursive: true })
	const filename = `memory-${entry.timestamp}-${entry.id.slice(0, 8)}.json`
	const filePath = path.join(dir, filename)
	const tmpPath = filePath + ".tmp"
	await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), "utf-8")
	await fs.rename(tmpPath, filePath)
}

/**
 * Prune all expired memory entries from disk.
 * Returns the number of entries removed.
 */
export async function pruneExpiredMemories(workspaceDir: string): Promise<number> {
	const dir = path.join(workspaceDir, SESSION_MEMORIES_DIR)
	try {
		const files = await fs.readdir(dir)
		const memoryFiles = files.filter((f) => f.startsWith("memory-") && f.endsWith(".json"))

		let removed = 0
		for (const file of memoryFiles) {
			try {
				const content = await fs.readFile(path.join(dir, file), "utf-8")
				const parsed = JSON.parse(content) as MemoryEntry
				const ttl = MEMORY_TTL[parsed.type] ?? MEMORY_TTL.session
				if (Date.now() - parsed.timestamp > ttl) {
					await fs.unlink(path.join(dir, file))
					removed++
				}
			} catch {
				// intentionally ignored: skip corrupted files
			}
		}
		return removed
	} catch {
		// intentionally ignored: memory cleanup failure
		return 0
	}
}
