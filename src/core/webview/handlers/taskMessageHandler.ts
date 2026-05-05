import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type ClineMessage,
	type EditQueuedMessagePayload,
	type WebviewMessage,
	checkoutDiffPayloadSchema,
	checkoutRestorePayloadSchema,
} from "@njust-ai-cj/types"
import { type ApiMessage } from "../../task-persistence/apiMessages"
import { saveTaskMessages } from "../../task-persistence"
import { getTheme } from "../../../integrations/theme/getTheme"
import { t } from "../../../i18n"
import { checkExistKey } from "../../../shared/checkExistApiConfig"
import { setPendingTodoList } from "../../tools/UpdateTodoListTool"
import { getCommand } from "../../../utils/commands"

import { handleCheckpointRestoreOperation } from "../checkpointRestoreHandler"
import { resolveIncomingImages } from "./shared-utils"
import { MessageRouter, type MessageHandlerContext } from "./MessageRouter"

export function registerTaskHandlers(router: MessageRouter): void {
	router.register("webviewDidLaunch", handleWebviewDidLaunch)
	router.register("newTask", handleNewTask)
	router.register("clearTask", handleClearTask)
	router.register("cancelTask", handleCancelTask)
	router.register("cancelAutoApproval", handleCancelAutoApproval)
	router.register("exportCurrentTask", handleExportCurrentTask)
	router.register("showTaskWithId", handleShowTaskWithId)
	router.register("deleteTaskWithId", handleDeleteTaskWithId)
	router.register("deleteMultipleTasksWithIds", handleDeleteMultipleTasksWithIds)
	router.register("exportTaskWithId", handleExportTaskWithId)
	router.register("getTaskWithAggregatedCosts", handleGetTaskWithAggregatedCosts)
	router.register("condenseTaskContextRequest", handleCondenseTaskContextRequest)
	router.register("didShowAnnouncement", handleDidShowAnnouncement)
	router.register("deleteMessage", handleDeleteMessage)
	router.register("submitEditedMessage", handleSubmitEditedMessage)
	router.register("deleteMessageConfirm", handleDeleteMessageConfirmEntry)
	router.register("editMessageConfirm", handleEditMessageConfirmEntry)
	router.register("updateTodoList", handleUpdateTodoList)
	router.register("focusPanelRequest", handleFocusPanelRequest)
	router.register("switchTab", handleSwitchTab)
	router.register("queueMessage", handleQueueMessage)
	router.register("removeQueuedMessage", handleRemoveQueuedMessage)
	router.register("editQueuedMessage", handleEditQueuedMessage)
	router.register("checkpointDiff", handleCheckpointDiff)
	router.register("checkpointRestore", handleCheckpointRestore)
	router.register("planAction", handlePlanAction)
}

// ── Shared helpers (message modification, task-internal) ──

function findMessageIndices(messageTs: number, currentCline: any) {
	const messageIndex = currentCline.clineMessages.findIndex((m: ClineMessage) => m.ts === messageTs)
	const allApiMatches = currentCline.apiConversationHistory
		.map((m: ApiMessage, idx: number) => ({ msg: m, idx }))
		.filter(({ msg }: { msg: ApiMessage }) => msg.ts === messageTs)
	const preferred = allApiMatches.find(({ msg }: { msg: ApiMessage }) => !msg.isSummary) || allApiMatches[0]
	return { messageIndex, apiConversationHistoryIndex: preferred?.idx ?? -1 }
}

function findFirstApiIndexAtOrAfter(ts: number, currentCline: any) {
	if (typeof ts !== "number") return -1
	return currentCline.apiConversationHistory.findIndex((m: ApiMessage) => typeof m?.ts === "number" && m.ts >= ts)
}

async function doDeleteOperation(context: MessageHandlerContext, messageTs: number): Promise<void> {
	const currentCline = context.provider.getCurrentTask()
	if (!currentCline) {
		await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete"))
		return
	}
	const { messageIndex } = findMessageIndices(messageTs, currentCline)
	let hasCheckpoint = false
	if (messageIndex !== -1) {
		const checkpoints = currentCline.clineMessages.filter((m: ClineMessage) => m.say === "checkpoint_saved" && m.ts! > messageTs)
		hasCheckpoint = checkpoints.length > 0
	}
	await context.provider.postMessageToWebview({ type: "showDeleteMessageDialog", messageTs, hasCheckpoint })
}

async function doDeleteConfirm(context: MessageHandlerContext, messageTs: number, restoreCheckpoint?: boolean): Promise<void> {
	const { provider } = context
	const currentCline = provider.getCurrentTask()
	if (!currentCline) return

	const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentCline)
	let apiIdx = apiConversationHistoryIndex
	if (apiIdx === -1 && typeof currentCline.clineMessages[messageIndex]?.ts === "number") {
		apiIdx = findFirstApiIndexAtOrAfter(currentCline.clineMessages[messageIndex].ts, currentCline)
	}
	if (messageIndex === -1) {
		await vscode.window.showErrorMessage(t("common:errors.message.message_not_found", { messageTs }))
		return
	}
	try {
		const target = currentCline.clineMessages[messageIndex]
		if (restoreCheckpoint) {
			const cps = currentCline.clineMessages.filter((m: ClineMessage) => m.say === "checkpoint_saved" && m.ts! > messageTs)
			if (cps[0]?.text) {
				await handleCheckpointRestoreOperation({
					provider, currentCline, messageTs: target.ts!, messageIndex,
					checkpoint: { hash: cps[0].text }, operation: "delete",
				})
			} else { vscode.window.showWarningMessage("No checkpoint found before this message") }
		} else {
			const saved = new Map<number, any>()
			for (let i = 0; i < messageIndex; i++) {
				const m = currentCline.clineMessages[i]
				if (m?.checkpoint && m.ts) saved.set(m.ts, m.checkpoint)
			}
			await currentCline.messageManager.rewindToTimestamp(target.ts!, { includeTargetMessage: false })
			for (const [ts, cp] of saved) {
				const idx = currentCline.clineMessages.findIndex((m: ClineMessage) => m.ts === ts)
				if (idx !== -1) currentCline.clineMessages[idx].checkpoint = cp
			}
			await saveTaskMessages({
				messages: currentCline.clineMessages, taskId: currentCline.taskId,
				globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
			})
			await provider.postStateToWebview()
		}
	} catch (e) {
		console.error("Error in delete message:", e)
		vscode.window.showErrorMessage(t("common:errors.message.error_deleting_message", { error: e instanceof Error ? e.message : String(e) }))
	}
}

async function doEditOperation(context: MessageHandlerContext, messageTs: number, editedContent: string, images?: string[]): Promise<void> {
	const currentCline = context.provider.getCurrentTask()
	let hasCheckpoint = false
	if (currentCline) {
		const { messageIndex } = findMessageIndices(messageTs, currentCline)
		if (messageIndex !== -1) {
			hasCheckpoint = currentCline.clineMessages.filter((m: ClineMessage) => m.say === "checkpoint_saved" && m.ts! > messageTs).length > 0
		}
	}
	await context.provider.postMessageToWebview({ type: "showEditMessageDialog", messageTs, text: editedContent, hasCheckpoint, images })
}

async function doEditConfirm(context: MessageHandlerContext, messageTs: number, editedContent: string, restoreCheckpoint?: boolean, images?: string[]): Promise<void> {
	const { provider } = context
	const currentCline = provider.getCurrentTask()
	if (!currentCline) return
	const { messageIndex, apiConversationHistoryIndex } = findMessageIndices(messageTs, currentCline)
	if (messageIndex === -1) {
		await vscode.window.showErrorMessage(t("common:errors.message.message_not_found", { messageTs }))
		return
	}
	try {
		const target = currentCline.clineMessages[messageIndex]
		if (restoreCheckpoint) {
			const cps = currentCline.clineMessages.filter((m: ClineMessage) => m.say === "checkpoint_saved" && m.ts! > messageTs)
			if (cps[0]?.text) {
				await handleCheckpointRestoreOperation({
					provider, currentCline, messageTs: target.ts!, messageIndex,
					checkpoint: { hash: cps[0].text }, operation: "edit",
					editData: { editedContent, images, apiConversationHistoryIndex },
				})
				return
			} else { vscode.window.showWarningMessage("No checkpoint found before this message") }
		}
		let delIdx = messageIndex
		let delApiIdx = apiConversationHistoryIndex
		for (let i = messageIndex; i >= 0; i--) {
			if (currentCline.clineMessages[i]?.say === "user_feedback") {
				delIdx = i
				const uts = currentCline.clineMessages[i].ts
				if (typeof uts === "number") {
					const ai = currentCline.apiConversationHistory.findIndex((m: ApiMessage) => m.ts === uts)
					if (ai !== -1) delApiIdx = ai
				}
				break
			}
		}
		if (delApiIdx === -1 && typeof currentCline.clineMessages[delIdx]?.ts === "number") {
			delApiIdx = findFirstApiIndexAtOrAfter(currentCline.clineMessages[delIdx].ts, currentCline)
		}
		const saved = new Map<number, any>()
		for (let i = 0; i < delIdx; i++) {
			const m = currentCline.clineMessages[i]
			if (m?.checkpoint && m.ts) saved.set(m.ts, m.checkpoint)
		}
		const rts = currentCline.clineMessages[delIdx]?.ts
		if (rts) await currentCline.messageManager.rewindToTimestamp(rts, { includeTargetMessage: false })
		for (const [ts, cp] of saved) {
			const idx = currentCline.clineMessages.findIndex((m: ClineMessage) => m.ts === ts)
			if (idx !== -1) currentCline.clineMessages[idx].checkpoint = cp
		}
		await saveTaskMessages({
			messages: currentCline.clineMessages, taskId: currentCline.taskId,
			globalStoragePath: provider.contextProxy.globalStorageUri.fsPath,
		})
		await provider.postStateToWebview()
		await currentCline.submitUserMessage(editedContent, images)
	} catch (e) {
		console.error("Error in edit message:", e)
		vscode.window.showErrorMessage(t("common:errors.message.error_editing_message", { error: e instanceof Error ? e.message : String(e) }))
	}
}

// ── Registered handlers ──

async function handleWebviewDidLaunch(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	const customModes = await provider.customModesManager.getCustomModes()
	await updateGlobalState("customModes", customModes)
	provider.postStateToWebview()
	provider.workspaceTracker?.initializeFilePaths()
	getTheme().then((t) => provider.postMessageToWebview({ type: "theme", text: JSON.stringify(t) }))
	const mcpHub = provider.getMcpHub()
	if (mcpHub) provider.postMessageToWebview({ type: "mcpServers", mcpServers: mcpHub.getAllServers() })
	provider.providerSettingsManager.listConfig().then(async (list) => {
		if (!list) return
		if (list.length === 1) {
			if (!checkExistKey(list[0])) {
				const { apiConfiguration } = await provider.getState()
				if (checkExistKey(apiConfiguration)) {
					await provider.providerSettingsManager.saveConfig(list[0].name ?? "default", apiConfiguration)
					list[0].apiProvider = apiConfiguration.apiProvider
				}
			}
		}
		const curName = context.getGlobalState("currentApiConfigName")
		if (curName && !(await provider.providerSettingsManager.hasConfig(curName))) {
			const name = list[0]?.name
			await updateGlobalState("currentApiConfigName", name)
			if (name) { await provider.activateProviderProfile({ name }); return }
		}
		await Promise.all([updateGlobalState("listApiConfigMeta", list), provider.postMessageToWebview({ type: "listApiConfig", listApiConfig: list })])
	}).catch((e: Error) => provider.log(`Error list api configuration: ${JSON.stringify(e, Object.getOwnPropertyNames(e), 2)}`))
	provider.isViewLaunched = true
}

async function handleNewTask(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	try {
		const resolved = await resolveIncomingImages(context, { text: message.text, images: message.images })
		await context.provider.createTask(resolved.text, resolved.images, undefined, { taskId: message.taskId }, message.taskConfiguration)
		await context.provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
	} catch (error) {
		await context.provider.postMessageToWebview({ type: "invoke", invoke: "newChat" })
		vscode.window.showErrorMessage(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function handleClearTask(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	await context.provider.clearTask()
	await context.provider.postStateToWebview()
}

async function handleCancelTask(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	await context.provider.cancelTask()
}

async function handleCancelAutoApproval(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	context.provider.getCurrentTask()?.cancelAutoApprovalTimeout()
}

async function handleExportCurrentTask(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const id = context.provider.getCurrentTask()?.taskId
	if (id) context.provider.exportTaskWithId(id)
}

async function handleShowTaskWithId(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	context.provider.showTaskWithId(message.text!)
}

async function handleCondenseTaskContextRequest(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	context.provider.condenseTaskContext(message.text!)
}

async function handleDeleteTaskWithId(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	context.provider.deleteTaskWithId(message.text!)
}

async function handleDeleteMultipleTasksWithIds(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const ids = message.ids
	if (!Array.isArray(ids)) return
	const BATCH = 20
	const results: { id: string; success: boolean }[] = []
	console.log(`Batch deletion started: ${ids.length} tasks total`)
	for (let i = 0; i < ids.length; i += BATCH) {
		const batch = ids.slice(i, i + BATCH)
		const r = await Promise.all(batch.map(async (id: string) => {
			try { await provider.deleteTaskWithId(id); return { id, success: true } }
			catch (e) { console.log(`Failed to delete task ${id}: ${e instanceof Error ? e.message : String(e)}`); return { id, success: false } }
		}))
		results.push(...r)
		await provider.postStateToWebview()
	}
	const ok = results.filter((r) => r.success).length
	console.log(`Batch deletion completed: ${ok}/${ids.length} tasks successful, ${ids.length - ok} tasks failed`)
}

async function handleExportTaskWithId(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	context.provider.exportTaskWithId(message.text!)
}

async function handleGetTaskWithAggregatedCosts(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	try {
		const taskId = message.text
		if (!taskId) throw new Error("Task ID is required")
		const result = await provider.getTaskWithAggregatedCosts(taskId)
		await provider.postMessageToWebview({ type: "taskWithAggregatedCosts", text: taskId, historyItem: result.historyItem, aggregatedCosts: result.aggregatedCosts })
	} catch (error) {
		console.error("Error getting task with aggregated costs:", error)
		await provider.postMessageToWebview({ type: "taskWithAggregatedCosts", text: message.text, error: error instanceof Error ? error.message : String(error) })
	}
}

async function handleDidShowAnnouncement(context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	const { provider, updateGlobalState } = context
	await updateGlobalState("lastShownAnnouncementId", provider.latestAnnouncementId)
	await provider.postStateToWebview()
}

async function handleDeleteMessage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (!context.provider.getCurrentTask()) {
		await vscode.window.showErrorMessage(t("common:errors.message.no_active_task_to_delete")); return
	}
	if (typeof message.value !== "number" || !Number.isFinite(message.value) || message.value <= 0) {
		await vscode.window.showErrorMessage(t("common:errors.message.invalid_timestamp_for_deletion")); return
	}
	await doDeleteOperation(context, message.value)
}

async function handleSubmitEditedMessage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (context.provider.getCurrentTask() && typeof message.value === "number" && message.value && message.editedMessageContent) {
		await doEditOperation(context, message.value, message.editedMessageContent, message.images)
	}
}

async function handleDeleteMessageConfirmEntry(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (!message.messageTs) { await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_missing_timestamp")); return }
	if (typeof message.messageTs !== "number") { await vscode.window.showErrorMessage(t("common:errors.message.cannot_delete_invalid_timestamp")); return }
	await doDeleteConfirm(context, message.messageTs, message.restoreCheckpoint)
}

async function handleEditMessageConfirmEntry(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.messageTs && message.text) {
		const resolved = await resolveIncomingImages(context, { text: message.text, images: message.images })
		await doEditConfirm(context, message.messageTs, resolved.text, message.restoreCheckpoint, resolved.images)
	}
}

async function handleUpdateTodoList(_context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const todos = (message.payload as any)?.todos
	if (Array.isArray(todos)) await setPendingTodoList(todos)
}

async function handleFocusPanelRequest(_context: MessageHandlerContext, _message: WebviewMessage): Promise<void> {
	await vscode.commands.executeCommand(getCommand("focusPanel"))
}

async function handleSwitchTab(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.tab) await context.provider.postMessageToWebview({ type: "action", action: "switchTab", tab: message.tab, values: message.values })
}

async function handleQueueMessage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const resolved = await resolveIncomingImages(context, { text: message.text, images: message.images })
	context.provider.getCurrentTask()?.messageQueueService.addMessage(resolved.text, resolved.images)
}

async function handleRemoveQueuedMessage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	context.provider.getCurrentTask()?.messageQueueService.removeMessage(message.text ?? "")
}

async function handleEditQueuedMessage(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	if (message.payload) {
		const { id, text, images } = message.payload as EditQueuedMessagePayload
		context.provider.getCurrentTask()?.messageQueueService.updateMessage(id, text, images)
	}
}

async function handleCheckpointDiff(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const r = checkoutDiffPayloadSchema.safeParse(message.payload)
	if (r.success) await context.provider.getCurrentTask()?.checkpointDiff(r.data)
}

async function handleCheckpointRestore(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const r = checkoutRestorePayloadSchema.safeParse(message.payload)
	if (!r.success) return
	await provider.cancelTask()
	try { await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, { timeout: 3_000 }) }
	catch { vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout")) }
	try { await provider.getCurrentTask()?.checkpointRestore(r.data) }
	catch { vscode.window.showErrorMessage(t("common:errors.checkpoint_failed")) }
}

async function handlePlanAction(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
	const { provider } = context
	const m = message as any
	const engine = provider.planEngine
	const pid = m.planId
	switch (m.action) {
		case "approve":
			await engine.approvePlan(pid)
			await provider.postMessageToWebview({ type: "planUpdate" as any, plan: engine.getPlan(pid) })
			break
		case "execute":
			engine.executePlan(pid, { onPlanUpdate: async (p: any) => { await provider.postMessageToWebview({ type: "planUpdate" as any, plan: p }) } })
				.catch((err: Error) => provider.log(`[PlanEngine] Execution error: ${err}`))
			break
		case "pause": engine.pausePlan(); break
		case "cancel":
			engine.deletePlan(pid)
			await provider.postMessageToWebview({ type: "planUpdate" as any, plan: null })
			break
		case "updateStep":
			engine.updateStep(pid, m.stepId, { description: m.description })
			await provider.postMessageToWebview({ type: "planUpdate" as any, plan: engine.getPlan(pid) })
			break
	}
}
