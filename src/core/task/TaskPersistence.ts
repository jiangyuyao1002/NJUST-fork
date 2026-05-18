import { v7 as uuidv7 } from "uuid"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ClineMessage } from "@njust-ai-cj/types"

import type { ApiMessage } from "../task-persistence"
import type { TaskMessageManager } from "./TaskMessageManager"

export function getSavedApiConversationHistoryWithTask(msgMgr: TaskMessageManager): Promise<ApiMessage[]> {
	return msgMgr.getSavedApiConversationHistory()
}

export function addToApiConversationHistoryWithTask(
	msgMgr: TaskMessageManager,
	message: Anthropic.MessageParam,
	reasoning?: string,
): Promise<void> {
	return msgMgr.addToApiConversationHistory(message, reasoning)
}

export function overwriteApiConversationHistoryWithTask(
	msgMgr: TaskMessageManager,
	newHistory: ApiMessage[],
): Promise<void> {
	return msgMgr.overwriteApiConversationHistory(newHistory)
}

export function flushPendingToolResultsToHistoryWithTask(msgMgr: TaskMessageManager): Promise<boolean> {
	return msgMgr.flushPendingToolResultsToHistory()
}

export function saveApiConversationHistoryWithTask(msgMgr: TaskMessageManager): Promise<boolean> {
	return msgMgr.saveApiConversationHistory()
}

export function retrySaveApiConversationHistoryWithTask(msgMgr: TaskMessageManager): Promise<boolean> {
	return msgMgr.retrySaveApiConversationHistory()
}

export function getSavedClineMessagesWithTask(msgMgr: TaskMessageManager): Promise<ClineMessage[]> {
	return msgMgr.getSavedClineMessages()
}

export function addToClineMessagesWithTask(
	msgMgr: TaskMessageManager,
	message: Omit<ClineMessage, "id"> & { id?: string },
): Promise<void> {
	if (!message.id) {
		message.id = uuidv7()
	}
	return msgMgr.addToClineMessages(message as ClineMessage)
}

export function overwriteClineMessagesWithTask(
	msgMgr: TaskMessageManager,
	newMessages: ClineMessage[],
): Promise<void> {
	return msgMgr.overwriteClineMessages(newMessages)
}

export function updateClineMessageWithTask(msgMgr: TaskMessageManager, message: ClineMessage): Promise<void> {
	return msgMgr.updateClineMessage(message)
}

export function saveClineMessagesWithTask(msgMgr: TaskMessageManager): Promise<boolean> {
	return msgMgr.saveClineMessages()
}

export function findMessageByTimestampWithTask(
	msgMgr: TaskMessageManager,
	ts: number,
): ClineMessage | undefined {
	return msgMgr.findMessageByTimestamp(ts)
}

export function findMessageByIdWithTask(msgMgr: TaskMessageManager, id: string): ClineMessage | undefined {
	return msgMgr.findMessageById(id)
}
