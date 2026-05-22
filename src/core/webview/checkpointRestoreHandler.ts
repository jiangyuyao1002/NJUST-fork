import { Task } from "../task/Task"
import { saveTaskMessages } from "../task-persistence"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { t } from "../../i18n"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

export interface ICheckpointRestoreHost {
	setPendingEditOperation(operationId: string, editData: {
		messageTs: number
		editedContent: string
		images?: string[]
		messageIndex: number
		apiConversationHistoryIndex: number
	}): void
	readonly contextProxy: { globalStorageUri: { fsPath: string } }
	getTaskWithId(id: string): Promise<{ historyItem: UnsafeAny }>
	createTaskWithHistoryItem(historyItem: UnsafeAny): Promise<Task | undefined>
	getCurrentTask(): Task | undefined
}

export interface CheckpointRestoreConfig {
	provider: ICheckpointRestoreHost
	currentCline: Task
	messageTs: number
	messageIndex: number
	checkpoint: { hash: string }
	operation: "delete" | "edit"
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

export async function handleCheckpointRestoreOperation(config: CheckpointRestoreConfig): Promise<void> {
	const { provider, currentCline, messageTs, checkpoint, operation, editData } = config

	try {
		if (operation === "delete" && currentCline && !currentCline.abort) {
			void currentCline.abortTask()
			await pWaitFor(() => currentCline.abort === true, {
				timeout: 1000,
				interval: 50,
			}).catch((e) => logger.warn("CheckpointRestore", `Abort wait timed out: ${e}`))
		}

		if (operation === "edit" && editData) {
			const operationId = `task-${currentCline.taskId}`
			provider.setPendingEditOperation(operationId, {
				messageTs,
				editedContent: editData.editedContent,
				images: editData.images,
				messageIndex: config.messageIndex,
				apiConversationHistoryIndex: editData.apiConversationHistoryIndex,
			})
		}

		await currentCline.checkpointRestore({
			ts: messageTs,
			commitHash: checkpoint.hash,
			mode: "restore",
			operation,
		})

		if (operation === "delete") {
			await saveTaskMessages({
				messages: currentCline.clineMessages,
				taskId: currentCline.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})

			const { historyItem } = await provider.getTaskWithId(currentCline.taskId)
			await provider.createTaskWithHistoryItem(historyItem)
		}
	} catch (error) {
		logger.error("CheckpointRestore", `Error in checkpoint restore (${operation}):`, error)
		TelemetryService.reportError(error, TelemetryEventName.CHECKPOINT_ERROR)
		vscode.window.showErrorMessage(
			`Error during checkpoint restore: ${getErrorMessage(error)}`,
		)
		throw error
	}
}

export async function waitForClineInitialization(provider: ICheckpointRestoreHost, timeoutMs: number = 3000): Promise<boolean> {
	try {
		await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, {
			timeout: timeoutMs,
		})
		return true
	} catch (_error) {
		vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
		return false
	}
}

