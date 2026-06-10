import * as fs from "fs/promises"
import * as path from "path"

import { getTaskDirectoryPath } from "../../utils/storage"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { logger } from "../../shared/logger"

export type RetryEvent = {
	taskId: string
	retryAttempt: number
	errorKind: string
	errorMessage?: string
	timestamp: number
	backoffSeconds?: number
}

const RETRY_EVENTS_FILE = "retry-events.json"
const MAX_RETRY_EVENTS = 200

async function getRetryEventsFile(globalStoragePath: string, taskId: string): Promise<string> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	return path.join(taskDir, RETRY_EVENTS_FILE)
}

export async function appendRetryEvent(globalStoragePath: string, event: RetryEvent): Promise<void> {
	const file = await getRetryEventsFile(globalStoragePath, event.taskId)
	let events: RetryEvent[] = []

	try {
		const raw = await fs.readFile(file, "utf8")
		events = JSON.parse(raw) as RetryEvent[]
	} catch {
		events = []
	}

	events.push(event)
	if (events.length > MAX_RETRY_EVENTS) {
		events = events.slice(events.length - MAX_RETRY_EVENTS)
	}

	await safeWriteJson(file, events)
}

export async function readRetryEvents(globalStoragePath: string, taskId: string): Promise<RetryEvent[]> {
	const file = await getRetryEventsFile(globalStoragePath, taskId)
	try {
		const raw = await fs.readFile(file, "utf8")
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as RetryEvent[]) : []
	} catch {
		return []
	}
}

export async function clearRetryEvents(globalStoragePath: string, taskId: string): Promise<void> {
	const file = await getRetryEventsFile(globalStoragePath, taskId)
	try {
		await fs.unlink(file)
	} catch (error) {
		logger.debug("RetryPersistence", "retry events file deletion failed", error)
		// ignore when file does not exist
	}
}
