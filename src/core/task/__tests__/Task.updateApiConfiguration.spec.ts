import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import type { ProviderSettings } from "@njust-ai-cj/types"

import { Task } from "../Task"
import type { ITaskHost } from "../interfaces/ITaskHost"
import { tokenCountCache } from "../../../utils/tokenCountCache"
import { buildApiHandler } from "../../../api"

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))

vi.mock("@njust-ai-cj/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task.updateApiConfiguration", () => {
	let mockProvider: { context: { globalStorageUri: { fsPath: string } }; getState: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> }
	let task: Task

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = {
			context: { globalStorageUri: { fsPath: "/test/path" } },
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		}
		task = new Task({
			provider: mockProvider as unknown as ITaskHost,
			apiConfiguration: { apiProvider: "anthropic", apiKey: "a" } as ProviderSettings,
			startTask: false,
		})
		vi.spyOn(task, "cancelCurrentRequest")
	})

	afterEach(() => {
		try {
			task.dispose()
		} catch {
			// ignore
		}
	})

	it("aborts in-flight work, clears parser-related state, invalidates token cache, and rebuilds API handler", () => {
		const clearSpy = vi.spyOn(tokenCountCache, "clear")
		const clearToolsSpy = vi.spyOn(task.toolCallParser, "clearAllStreamingToolCalls")
		const clearRawSpy = vi.spyOn(task.toolCallParser, "clearRawChunkState")
		task.cachedStreamingModel = { id: "old", info: {} as any }
		;(task as any).tokenUsageSnapshot = { totalTokensIn: 1, totalTokensOut: 0, contextTokens: 0 }
		task.userMessageContent = [{ type: "text", text: "x" }] as any
		task.presentAssistantMessageLocked = true

		task.updateApiConfiguration({ apiProvider: "openrouter", apiKey: "b" } as ProviderSettings)

		expect(task.cancelCurrentRequest).toHaveBeenCalled()
		expect(clearToolsSpy).toHaveBeenCalled()
		expect(clearRawSpy).toHaveBeenCalled()
		expect(clearSpy).toHaveBeenCalled()
		expect(task.cachedStreamingModel).toBeUndefined()
		expect((task as any).tokenUsageSnapshot).toBeUndefined()
		expect(task.userMessageContent).toEqual([])
		expect(task.presentAssistantMessageLocked).toBe(false)
		expect(buildApiHandler).toHaveBeenCalled()
	})
})
