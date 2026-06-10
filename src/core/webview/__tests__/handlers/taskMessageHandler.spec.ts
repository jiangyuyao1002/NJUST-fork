import { vi, describe, it, expect, beforeEach } from "vitest"
import type { WebviewMessage } from "@njust-ai/types"

vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../../shared/checkExistApiConfig", () => ({ checkExistKey: vi.fn().mockReturnValue(false) }))
vi.mock("../../../../utils/commands", () => ({ getCommand: (cmd: string) => `njust-ai.${cmd}` }))
vi.mock("../../../tools/UpdateTodoListTool", () => ({ setPendingTodoList: vi.fn() }))
vi.mock("../../checkpointRestoreHandler", () => ({ handleCheckpointRestoreOperation: vi.fn() }))
vi.mock("../../../integrations/theme/getTheme", () => ({ getTheme: vi.fn().mockResolvedValue({}) }))
vi.mock("../../../../shared/package", () => ({ Package: { name: "njust-ai" } }))
vi.mock("../../../task-persistence", () => ({ saveTaskMessages: vi.fn() }))
vi.mock("../../handlers/shared-utils", () => ({
	resolveIncomingImages: vi
		.fn()
		.mockImplementation((_ctx: any, data: any) => Promise.resolve({ text: data.text, images: data.images })),
}))

import { registerTaskHandlers } from "../../handlers/taskMessageHandler"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("taskMessageHandler", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		context = createMockContext()
		registerTaskHandlers(router)
	})

	it("registers all expected task handlers", () => {
		const registeredTypes = [
			"webviewDidLaunch",
			"newTask",
			"clearTask",
			"cancelTask",
			"cancelAutoApproval",
			"exportCurrentTask",
			"showTaskWithId",
			"deleteTaskWithId",
			"deleteMultipleTasksWithIds",
			"exportTaskWithId",
			"getTaskWithAggregatedCosts",
			"condenseTaskContextRequest",
			"didShowAnnouncement",
			"deleteMessage",
			"submitEditedMessage",
			"deleteMessageConfirm",
			"editMessageConfirm",
			"updateTodoList",
			"focusPanelRequest",
			"switchTab",
			"queueMessage",
			"removeQueuedMessage",
			"editQueuedMessage",
			"checkpointDiff",
			"checkpointRestore",
			"planAction",
		]
		for (const type of registeredTypes) {
			const handler = vi.fn()
			router.register(type, handler)
		}
	})

	it("clearTask calls provider.clearTask and postStateToWebview", async () => {
		;(context.provider.clearTask as any).mockResolvedValue(undefined)

		await router.route(context, { type: "clearTask" } as WebviewMessage)

		expect(context.provider.clearTask).toHaveBeenCalledOnce()
		expect(context.provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("cancelTask calls provider.cancelTask", async () => {
		;(context.provider.cancelTask as any).mockResolvedValue(undefined)

		await router.route(context, { type: "cancelTask" } as WebviewMessage)

		expect(context.provider.cancelTask).toHaveBeenCalledOnce()
	})

	it("cancelAutoApproval calls cancelAutoApprovalTimeout on current task", async () => {
		const mockCancel = vi.fn()
		;(context.provider.getCurrentTask as any).mockReturnValue({ cancelAutoApprovalTimeout: mockCancel })

		await router.route(context, { type: "cancelAutoApproval" } as WebviewMessage)

		expect(mockCancel).toHaveBeenCalledOnce()
	})

	it("cancelAutoApproval does nothing when no current task", async () => {
		;(context.provider.getCurrentTask as any).mockReturnValue(null)

		await expect(router.route(context, { type: "cancelAutoApproval" } as WebviewMessage)).resolves.not.toThrow()
	})

	it("exportCurrentTask calls exportTaskWithId with current task id", async () => {
		;(context.provider.getCurrentTask as any).mockReturnValue({ taskId: "task-123" })

		await router.route(context, { type: "exportCurrentTask" } as WebviewMessage)

		expect(context.provider.exportTaskWithId).toHaveBeenCalledWith("task-123")
	})

	it("exportCurrentTask does nothing when no current task", async () => {
		;(context.provider.getCurrentTask as any).mockReturnValue(null)

		await router.route(context, { type: "exportCurrentTask" } as WebviewMessage)

		expect(context.provider.exportTaskWithId).not.toHaveBeenCalled()
	})

	it("showTaskWithId calls provider.showTaskWithId", async () => {
		await router.route(context, { type: "showTaskWithId", text: "task-456" } as WebviewMessage)

		expect(context.provider.showTaskWithId).toHaveBeenCalledWith("task-456")
	})

	it("deleteTaskWithId calls provider.deleteTaskWithId", async () => {
		await router.route(context, { type: "deleteTaskWithId", text: "task-789" } as WebviewMessage)

		expect(context.provider.deleteTaskWithId).toHaveBeenCalledWith("task-789")
	})

	it("didShowAnnouncement updates lastShownAnnouncementId", async () => {
		;(context.provider as any).latestAnnouncementId = "announcement-v2"

		await router.route(context, { type: "didShowAnnouncement" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("lastShownAnnouncementId", "announcement-v2")
	})

	it("switchTab posts action message to webview", async () => {
		await router.route(context, { type: "switchTab", tab: "settings", values: { key: "val" } } as any)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "switchTab",
			tab: "settings",
			values: { key: "val" },
		})
	})

	it("updateTodoList does not throw with valid todos payload", async () => {
		const todos = [{ id: "1", text: "test", status: "pending" }]

		await expect(
			router.route(context, { type: "updateTodoList", payload: { todos } } as any),
		).resolves.not.toThrow()
	})

	it("focusPanelRequest executes focusPanel command", async () => {
		const vscode = await import("vscode")

		await router.route(context, { type: "focusPanelRequest" } as WebviewMessage)

		expect(vscode.commands.executeCommand).toHaveBeenCalledWith("njust-ai.focusPanel")
	})

	it("newTask calls createTask on provider", async () => {
		;(context.provider.createTask as any).mockResolvedValue(undefined)

		await router.route(context, { type: "newTask", text: "do something", images: [] } as any)

		expect(context.provider.createTask).toHaveBeenCalledWith(
			"do something",
			[],
			undefined,
			expect.any(Object),
			undefined,
		)
	})

	it("condenseTaskContextRequest calls provider.condenseTaskContext", async () => {
		await router.route(context, { type: "condenseTaskContextRequest", text: "task-id" } as WebviewMessage)

		expect(context.provider.condenseTaskContext).toHaveBeenCalledWith("task-id")
	})
})
