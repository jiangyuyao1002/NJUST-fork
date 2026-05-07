import * as fs from "fs"
import * as path from "path"
import type { Memento } from "vscode"
import type { HistoryItem } from "@njust-ai-cj/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getStorageBasePath } from "../../utils/storage"
import { logger } from "../../shared/logger"

export const WORKSPACE_STATE_KEY = "cangjie.generatedTestFiles"
export const NO_TASK_KEY = "__no_task__"

/** Paths of `*_test.cj` created via command, keyed by chat task id (dispose + prune clean up). */
const byTaskId = new Map<string, Set<string>>()

let workspaceState: Memento | undefined

export function initTestCleanup(memento: Memento): void {
	workspaceState = memento
	const saved = memento.get<Record<string, string[]>>(WORKSPACE_STATE_KEY, {})
	for (const [taskId, paths] of Object.entries(saved)) {
		if (!Array.isArray(paths)) continue
		byTaskId.set(taskId, new Set(paths.map((p) => path.normalize(p))))
	}
}

interface HistoryIndexFile {
	version?: number
	entries?: HistoryItem[]
}

/** Load task id → history row from the same `_index.json` TaskHistoryStore uses (before the store async-init finishes). */
async function loadHistoryIndexMap(globalStorageUriFsPath: string): Promise<Map<string, HistoryItem>> {
	const m = new Map<string, HistoryItem>()
	try {
		const basePath = await getStorageBasePath(globalStorageUriFsPath)
		const indexPath = path.join(basePath, "tasks", GlobalFileNames.historyIndex)
		if (!fs.existsSync(indexPath)) return m
		const raw = fs.readFileSync(indexPath, "utf-8")
		const index = JSON.parse(raw) as HistoryIndexFile
		if (index.version === 1 && Array.isArray(index.entries)) {
			for (const entry of index.entries) {
				if (entry?.id) m.set(entry.id, entry)
			}
		}
	} catch (e) {
		logger.warn("CangjieTestCleanup", "读取任务历史索引失败（孤儿清理将跳过非 __no_task__ 的精确判断）:", e)
	}
	return m
}

/**
 * Extension 激活后尽早运行：依据 workspaceState 恢复的登记与磁盘上的 task history 索引，
 * 删除不应保留的任务桶下文件（与 ClineProvider 内 prune 规则一致）。
 * 在 `initTestCleanup` 之后调用。
 */
export async function cleanupOrphanedTestFiles(globalStorageUriFsPath: string): Promise<{
	taskEntriesRemoved: number
	filesRemoved: number
}> {
	const historyById = await loadHistoryIndexMap(globalStorageUriFsPath)
	return pruneStaleRegistrations((id) => {
		if (id === NO_TASK_KEY) return false
		const h = historyById.get(id)
		if (!h || h.status === "completed") return false
		return true
	})
}

function persistToState(): void {
	if (!workspaceState) return
	const obj: Record<string, string[]> = {}
	for (const [k, v] of byTaskId) {
		obj[k] = [...v]
	}
	void workspaceState.update(WORKSPACE_STATE_KEY, obj)
}

/** Remove one task bucket and delete its files. Returns number of files deleted from disk. */
function removeTaskEntryAndDeleteFiles(taskId: string): number {
	const set = byTaskId.get(taskId)
	if (!set) return 0
	byTaskId.delete(taskId)
	let removed = 0
	for (const p of set) {
		try {
			const base = path.basename(p)
			if (!base.endsWith("_test.cj")) continue
			if (fs.existsSync(p) && fs.statSync(p).isFile()) {
				fs.unlinkSync(p)
				removed++
			}
		} catch (e) {
			logger.warn("CangjieTestCleanup", `删除失败 ${p}:`, e)
		}
	}
	return removed
}

export function registerGeneratedCangjieTestFile(taskId: string | undefined, absPath: string): void {
	const key = taskId ?? NO_TASK_KEY
	const norm = path.normalize(absPath)
	let set = byTaskId.get(key)
	if (!set) {
		set = new Set()
		byTaskId.set(key, set)
	}
	set.add(norm)
	persistToState()
}

/**
 * Delete all command-generated test files for this task. Safe: only removes paths we recorded, basename ends with `_test.cj`.
 */
export function deleteGeneratedCangjieTestFilesForTask(taskId: string): void {
	removeTaskEntryAndDeleteFiles(taskId)
	persistToState()
}

/**
 * Drop stale registrations: `shouldRetainTaskId(id)` true = keep bucket; false = delete files and remove bucket.
 */
export function pruneStaleRegistrations(shouldRetainTaskId: (id: string) => boolean): {
	taskEntriesRemoved: number
	filesRemoved: number
} {
	let taskEntriesRemoved = 0
	let filesRemoved = 0
	for (const id of [...byTaskId.keys()]) {
		if (shouldRetainTaskId(id)) continue
		filesRemoved += removeTaskEntryAndDeleteFiles(id)
		taskEntriesRemoved++
	}
	persistToState()
	return { taskEntriesRemoved, filesRemoved }
}

/** Manual safety net: delete every tracked path and clear workspace state. */
export function purgeAllTrackedCangjieTestFiles(): { filesRemoved: number; taskEntriesRemoved: number } {
	let filesRemoved = 0
	let taskEntriesRemoved = 0
	for (const id of [...byTaskId.keys()]) {
		filesRemoved += removeTaskEntryAndDeleteFiles(id)
		taskEntriesRemoved++
	}
	persistToState()
	return { filesRemoved, taskEntriesRemoved }
}
