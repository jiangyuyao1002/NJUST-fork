import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@njust-ai-cj/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	const fileExists = await fileExistsAtPath(filePath)

	if (fileExists) {
		try {
			const parsedData = JSON.parse(await fs.readFile(filePath, "utf8"))
			if (!Array.isArray(parsedData)) {
				logger.warn("TaskMessages", 
					`[readTaskMessages] Parsed data is not an array (got ${typeof parsedData}), returning empty. TaskId: ${taskId}, Path: ${filePath}`,
				)
				return []
			}
			return parsedData
		} catch (error) {
			logger.warn("TaskMessages", 
				`[readTaskMessages] Failed to parse ${filePath} for task ${taskId}, returning empty: ${getErrorMessage(error)}`,
			)
			TelemetryService.reportError(error instanceof Error ? error : new Error(getErrorMessage(error)), TelemetryEventName.UTILITY_ERROR)
			return []
		}
	}

	return []
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
}

export async function saveTaskMessages({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	// safeWriteJson: temp file + rename under lock (crash-safe).
	await safeWriteJson(filePath, messages)
}
/**
 * Save only new messages since the last full save.
 * Uses a counter file to track how many messages were in the last full persistence.
 * When the delta exceeds DELTA_COMPACTION_THRESHOLD, performs a full compaction save instead.
 */
const DELTA_COMPACTION_THRESHOLD = 200

export async function saveTaskMessagesIncremental({ messages, taskId, globalStoragePath }: SaveTaskMessagesOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	const countFilePath = path.join(taskDir, GlobalFileNames.uiMessages + ".count")

	let lastFullCount = 0
	try {
		const countData = await fs.readFile(countFilePath, "utf-8")
		lastFullCount = parseInt(countData, 10) || 0
	} catch {
		// No count file yet — will do full save
	}

	const delta = messages.length - lastFullCount
	if (delta <= 0 || messages.length < lastFullCount || delta >= DELTA_COMPACTION_THRESHOLD) {
		// Full save: messages were truncated/rewound, or delta is large enough to compact
		await safeWriteJson(filePath, messages)
		await fs.writeFile(countFilePath, String(messages.length), "utf-8")
		return
	}

	// Incremental: serialize only the new messages and append to an append log
	const appendFilePath = filePath + ".append"
	const newMessages = messages.slice(lastFullCount)
	const appendLine = JSON.stringify(newMessages) + "\n"
	await fs.appendFile(appendFilePath, appendLine, "utf-8")
	await fs.writeFile(countFilePath, String(messages.length), "utf-8")
}