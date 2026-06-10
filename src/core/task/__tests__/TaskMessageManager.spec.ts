import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
	readApiMessagesMock,
	saveApiMessagesMock,
	readTaskMessagesMock,
	saveTaskMessagesMock,
	taskMetadataMock,
	getEffectiveApiHistoryMock,
	validateAndFixToolResultIdsMock,
	restoreTodoListForTaskMock,
} = vi.hoisted(() => ({
	readApiMessagesMock: vi.fn(),
	saveApiMessagesMock: vi.fn(),
	readTaskMessagesMock: vi.fn(),
	saveTaskMessagesMock: vi.fn(),
	taskMetadataMock: vi.fn(),
	getEffectiveApiHistoryMock: vi.fn(),
	validateAndFixToolResultIdsMock: vi.fn(),
	restoreTodoListForTaskMock: vi.fn(),
}))

vi.mock("../../task-persistence", () => ({
	readApiMessages: readApiMessagesMock,
	saveApiMessages: saveApiMessagesMock,
	readTaskMessages: readTaskMessagesMock,
	saveTaskMessages: saveTaskMessagesMock,
	taskMetadata: taskMetadataMock,
}))

vi.mock("../../condense", () => ({
	getEffectiveApiHistory: getEffectiveApiHistoryMock,
}))

vi.mock("../validateToolResultIds", () => ({
	validateAndFixToolResultIds: validateAndFixToolResultIdsMock,
}))

vi.mock("../../tools/UpdateTodoListTool", () => ({
	restoreTodoListForTask: restoreTodoListForTaskMock,
}))

import { TaskMessageManager, type TaskMessageContext } from "../TaskMessageManager"

function createContext(overrides: Partial<TaskMessageContext> = {}): TaskMessageContext {
	return {
		taskId: "task-1",
		instanceId: "instance-1",
		globalStoragePath: "D:\\storage",
		rootTaskId: "root-1",
		parentTaskId: "parent-1",
		taskNumber: 7,
		abort: false,
		apiConversationHistory: [],
		clineMessages: [],
		userMessageContent: [],
		assistantMessageSavedToHistory: true,
		lastMessageTs: 0,
		api: {},
		apiConfiguration: { apiProvider: "openai" } as any,
		_taskMode: "code",
		_taskApiConfigName: "default",
		taskApiConfigReady: Promise.resolve(),
		initialStatus: "active",
		cwd: "D:\\repo",
		debouncedEmitTokenUsage: vi.fn(),
		toolUsage: { read_file: 1 },
		emit: vi.fn(),
		notifier: {
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		},
		...overrides,
	} as TaskMessageContext
}

describe("TaskMessageManager", () => {
	beforeEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		readApiMessagesMock.mockResolvedValue([])
		saveApiMessagesMock.mockResolvedValue(undefined)
		readTaskMessagesMock.mockResolvedValue([])
		saveTaskMessagesMock.mockResolvedValue(undefined)
		taskMetadataMock.mockResolvedValue({
			historyItem: { id: "task-1" },
			tokenUsage: { totalTokens: 12 },
		})
		getEffectiveApiHistoryMock.mockImplementation((history: any[]) => [...history])
		validateAndFixToolResultIdsMock.mockImplementation((message: any) => message)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("reads saved API conversation history for the current task", async () => {
		readApiMessagesMock.mockResolvedValueOnce([{ role: "user", content: "hi" }])
		const manager = new TaskMessageManager(createContext())

		await expect(manager.getSavedApiConversationHistory()).resolves.toEqual([{ role: "user", content: "hi" }])
		expect(readApiMessagesMock).toHaveBeenCalledWith({ taskId: "task-1", globalStoragePath: "D:\\storage" })
	})

	it("stores assistant response id and generic reasoning for non-anthropic providers", async () => {
		const ctx = createContext({
			api: {
				getResponseId: () => "resp-1",
				getSummary: () => [{ text: "summary" }],
			} as any,
			apiConfiguration: { apiProvider: "openai", openAiModelId: "gpt-5" } as any,
		})
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory({ role: "assistant", content: "answer" }, "reasoning text")

		expect(ctx.apiConversationHistory).toHaveLength(1)
		const saved = ctx.apiConversationHistory[0] as any
		expect(saved.id).toBe("resp-1")
		expect(saved.reasoning_content).toBe("reasoning text")
		expect(saved.content[0]).toMatchObject({ type: "reasoning", text: "reasoning text" })
		expect(saved.content[1]).toMatchObject({ type: "text", text: "answer" })
		expect(saveApiMessagesMock).toHaveBeenCalled()
	})

	it("stores encrypted reasoning when provider exposes encrypted content", async () => {
		const ctx = createContext({
			api: {
				getEncryptedContent: () => ({ encrypted_content: "ciphertext", id: "reason-1" }),
			} as any,
		})
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory({ role: "assistant", content: [] })

		expect((ctx.apiConversationHistory[0] as any).content[0]).toMatchObject({
			type: "reasoning",
			encrypted_content: "ciphertext",
			id: "reason-1",
		})
	})

	it("appends non-anthropic thought signatures as provider-specific blocks", async () => {
		const ctx = createContext({
			api: {
				getThoughtSignature: () => "sig-1",
			} as any,
			apiConfiguration: { apiProvider: "openai", openAiModelId: "gpt-5" } as any,
		})
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory({ role: "assistant", content: "answer" })

		expect((ctx.apiConversationHistory[0] as any).content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thoughtSignature", thoughtSignature: "sig-1" },
		])
	})

	it("keeps reasoning_details without duplicating plain reasoning", async () => {
		const ctx = createContext({
			api: {
				getReasoningDetails: () => [{ type: "summary_text", text: "detail" }],
			} as any,
		})
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory({ role: "assistant", content: "answer" }, "ignored")

		const saved = ctx.apiConversationHistory[0] as any
		expect(saved.reasoning_details).toEqual([{ type: "summary_text", text: "detail" }])
		expect(saved.reasoning_content).toBeUndefined()
		expect(saved.content).toBe("answer")
	})

	it("converts orphan user tool_result blocks to text before validation", async () => {
		const ctx = createContext({
			apiConversationHistory: [{ role: "user", content: "previous", ts: 1 } as any],
		})
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" } as any],
		})

		expect(validateAndFixToolResultIdsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [{ type: "text", text: "Tool result:\nok" }],
			}),
			[],
		)
	})

	it("validates user tool results against the previous effective assistant message", async () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
		}
		const ctx = createContext({ apiConversationHistory: [assistant as any] })
		const user = { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } as any
		const manager = new TaskMessageManager(ctx)

		await manager.addToApiConversationHistory(user)

		expect(validateAndFixToolResultIdsMock).toHaveBeenCalledWith(user, [assistant])
		expect(ctx.apiConversationHistory.at(-1)).toMatchObject({ role: "user" })
	})

	it("overwrites API conversation history and persists it", async () => {
		const ctx = createContext()
		const manager = new TaskMessageManager(ctx)
		const history = [{ role: "user", content: "new" }] as any[]

		await manager.overwriteApiConversationHistory(history)

		expect(ctx.apiConversationHistory).toBe(history)
		expect(saveApiMessagesMock).toHaveBeenCalled()
	})

	it("flushes pending tool results and clears them after a successful save", async () => {
		const ctx = createContext({
			apiConversationHistory: [{ role: "assistant", content: "ready" } as any],
			userMessageContent: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" } as any],
		})
		const manager = new TaskMessageManager(ctx)

		await expect(manager.flushPendingToolResultsToHistory()).resolves.toBe(true)

		expect(ctx.apiConversationHistory.at(-1)).toMatchObject({ role: "user" })
		expect(ctx.userMessageContent).toEqual([])
	})

	it("keeps pending tool results when API history save fails", async () => {
		saveApiMessagesMock.mockRejectedValueOnce(new Error("disk full"))
		const ctx = createContext({
			apiConversationHistory: [{ role: "assistant", content: "ready" } as any],
			userMessageContent: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" } as any],
		})
		const manager = new TaskMessageManager(ctx)

		await expect(manager.flushPendingToolResultsToHistory()).resolves.toBe(false)

		expect(ctx.userMessageContent).toHaveLength(1)
	})

	it("does not flush pending tool results after abort", async () => {
		const ctx = createContext({
			abort: true,
			assistantMessageSavedToHistory: false,
			userMessageContent: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" } as any],
		})
		const manager = new TaskMessageManager(ctx)

		await expect(manager.flushPendingToolResultsToHistory()).resolves.toBe(false)

		expect(saveApiMessagesMock).not.toHaveBeenCalled()
	})

	it("returns true without saving when no pending tool results exist", async () => {
		const manager = new TaskMessageManager(createContext({ userMessageContent: [] }))

		await expect(manager.flushPendingToolResultsToHistory()).resolves.toBe(true)
		expect(saveApiMessagesMock).not.toHaveBeenCalled()
	})

	it("retries saving API history until a retry succeeds", async () => {
		vi.useFakeTimers()
		const manager = new TaskMessageManager(createContext())
		saveApiMessagesMock.mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce(undefined)

		const result = manager.retrySaveApiConversationHistory()
		await vi.advanceTimersByTimeAsync(100)
		await vi.advanceTimersByTimeAsync(500)

		await expect(result).resolves.toBe(true)
		expect(saveApiMessagesMock).toHaveBeenCalledTimes(2)
	})

	it("reads saved Cline messages for the current task", async () => {
		readTaskMessagesMock.mockResolvedValueOnce([{ ts: 1, type: "say", say: "text" }])
		const manager = new TaskMessageManager(createContext())

		await expect(manager.getSavedClineMessages()).resolves.toEqual([{ ts: 1, type: "say", say: "text" }])
		expect(readTaskMessagesMock).toHaveBeenCalledWith({ taskId: "task-1", globalStoragePath: "D:\\storage" })
	})

	it("adds Cline messages, posts state, emits creation, and saves", async () => {
		const ctx = createContext()
		const manager = new TaskMessageManager(ctx)
		const message = { ts: 123, type: "say", say: "text", text: "hello" } as any

		await manager.addToClineMessages(message)

		expect(ctx.clineMessages).toEqual([message])
		expect(ctx.notifier?.postStateToWebviewWithoutTaskHistory).toHaveBeenCalled()
		expect(ctx.emit).toHaveBeenCalledWith(expect.any(String), { action: "created", message })
		expect(saveTaskMessagesMock).toHaveBeenCalled()
	})

	it("overwrites Cline messages, restores todos, and persists", async () => {
		const ctx = createContext()
		const manager = new TaskMessageManager(ctx)
		const messages = [{ ts: 2, type: "say", say: "text" }] as any[]

		await manager.overwriteClineMessages(messages)

		expect(ctx.clineMessages).toBe(messages)
		expect(restoreTodoListForTaskMock).toHaveBeenCalledWith(ctx)
		expect(saveTaskMessagesMock).toHaveBeenCalled()
	})

	it("updates a Cline message through notifier and event emission", async () => {
		const ctx = createContext()
		const manager = new TaskMessageManager(ctx)
		const message = { ts: 3, type: "ask", ask: "tool" } as any

		await manager.updateClineMessage(message)

		expect(ctx.notifier?.postMessageToWebview).toHaveBeenCalledWith({
			type: "messageUpdated",
			clineMessage: message,
		})
		expect(ctx.emit).toHaveBeenCalledWith(expect.any(String), { action: "updated", message })
	})

	it("saves Cline messages with metadata and task history update", async () => {
		const ctx = createContext({ _taskApiConfigName: undefined })
		const manager = new TaskMessageManager(ctx)

		await expect(manager.saveClineMessages()).resolves.toBe(true)

		expect(taskMetadataMock).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				rootTaskId: "root-1",
				parentTaskId: "parent-1",
				taskNumber: 7,
				workspace: "D:\\repo",
				mode: "code",
			}),
		)
		expect(ctx.debouncedEmitTokenUsage).toHaveBeenCalledWith({ totalTokens: 12 }, ctx.toolUsage)
		expect(ctx.notifier?.updateTaskHistory).toHaveBeenCalledWith({ id: "task-1" })
	})

	it("returns false when saving Cline messages fails", async () => {
		saveTaskMessagesMock.mockRejectedValueOnce(new Error("write failed"))
		const manager = new TaskMessageManager(createContext())

		await expect(manager.saveClineMessages()).resolves.toBe(false)
	})

	it("finds messages by timestamp or id from the newest matching entry", () => {
		const first = { id: "same", ts: 10, type: "say", say: "text", text: "old" } as any
		const newest = { id: "same", ts: 20, type: "say", say: "text", text: "new" } as any
		const manager = new TaskMessageManager(createContext({ clineMessages: [first, newest] }))

		expect(manager.findMessageByTimestamp(20)).toBe(newest)
		expect(manager.findMessageById("same")).toBe(newest)
		expect(manager.findMessageByTimestamp(999)).toBeUndefined()
		expect(manager.findMessageById("missing")).toBeUndefined()
	})
})
