import { vi, describe, it, expect, beforeEach } from "vitest"
import type { WebviewMessage } from "@njust-ai/types"

vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
}))

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: { getAllInstances: vi.fn().mockReturnValue([]) },
}))

import { registerIndexingHandlers } from "../../handlers/indexingMessageHandler"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("indexingMessageHandler", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		context = createMockContext()
		registerIndexingHandlers(router)
	})

	it("registers all 8 indexing handlers", () => {
		const registeredTypes = [
			"saveCodeIndexSettingsAtomic", "requestIndexingStatus", "requestCodeIndexSecretStatus",
			"startIndexing", "stopIndexing", "toggleWorkspaceIndexing", "setAutoEnableDefault", "clearIndexData",
		]
		for (const type of registeredTypes) {
			const handler = vi.fn()
			router.register(type, handler)
		}
	})

	it("requestIndexingStatus posts error when no workspace manager", async () => {
		;(context.provider.getCurrentWorkspaceCodeIndexManager as any).mockReturnValue(null)

		await router.route(context, { type: "requestIndexingStatus" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "indexingStatusUpdate" }),
		)
	})

	it("requestIndexingStatus posts status when manager exists", async () => {
		const mockStatus = { systemStatus: "Ready", processedItems: 10, totalItems: 10, currentItemUnit: "items" }
		const mockMgr = { getCurrentStatus: vi.fn().mockReturnValue(mockStatus) }
		;(context.provider.getCurrentWorkspaceCodeIndexManager as any).mockReturnValue(mockMgr)

		await router.route(context, { type: "requestIndexingStatus" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: mockStatus,
		})
	})

	it("startIndexing initializes and starts when manager exists", async () => {
		const mockMgr = {
			setWorkspaceEnabled: vi.fn().mockResolvedValue(undefined),
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: false,
			state: "Standby",
			startIndexing: vi.fn(),
			initialize: vi.fn().mockResolvedValue(undefined),
		}
		;(context.provider.getCurrentWorkspaceCodeIndexManager as any).mockReturnValue(mockMgr)

		await router.route(context, { type: "startIndexing" } as WebviewMessage)

		expect(mockMgr.setWorkspaceEnabled).toHaveBeenCalledWith(true)
	})

	it("stopIndexing stops and posts status", async () => {
		const mockStatus = { systemStatus: "Standby" }
		const mockMgr = {
			stopIndexing: vi.fn(),
			getCurrentStatus: vi.fn().mockReturnValue(mockStatus),
		}
		;(context.provider.getCurrentWorkspaceCodeIndexManager as any).mockReturnValue(mockMgr)

		await router.route(context, { type: "stopIndexing" } as WebviewMessage)

		expect(mockMgr.stopIndexing).toHaveBeenCalledOnce()
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexingStatusUpdate",
			values: mockStatus,
		})
	})

	it("clearIndexData clears and posts success", async () => {
		const mockMgr = { clearIndexData: vi.fn().mockResolvedValue(undefined) }
		;(context.provider.getCurrentWorkspaceCodeIndexManager as any).mockReturnValue(mockMgr)

		await router.route(context, { type: "clearIndexData" } as WebviewMessage)

		expect(mockMgr.clearIndexData).toHaveBeenCalledOnce()
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "indexCleared",
			values: { success: true },
		})
	})
})
