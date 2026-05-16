import { beforeEach, describe, expect, it, vi } from "vitest"

const {
	appendFileMock,
	getTaskDirectoryPathMock,
	getSummaryMock,
	getBreaksBySourceMock,
	getTotalBreaksMock,
	clearMcpInstructionsDeltaMock,
	deleteGeneratedCangjieTestFilesForTaskMock,
	releaseTerminalsForTaskMock,
	outputCleanupMock,
} = vi.hoisted(() => ({
	appendFileMock: vi.fn(),
	getTaskDirectoryPathMock: vi.fn(),
	getSummaryMock: vi.fn(),
	getBreaksBySourceMock: vi.fn(),
	getTotalBreaksMock: vi.fn(),
	clearMcpInstructionsDeltaMock: vi.fn(),
	deleteGeneratedCangjieTestFilesForTaskMock: vi.fn(),
	releaseTerminalsForTaskMock: vi.fn(),
	outputCleanupMock: vi.fn(),
}))

vi.mock("fs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		promises: {
			...(actual.promises as Record<string, unknown>),
			appendFile: appendFileMock,
		},
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: getTaskDirectoryPathMock,
}))

vi.mock("../../../utils/cacheMetrics", () => ({
	globalCacheMetrics: {
		getSummary: getSummaryMock,
	},
}))

vi.mock("../../prompts/promptCacheBreakDetection", () => ({
	globalPromptCacheBreakDetector: {
		getBreaksBySource: getBreaksBySourceMock,
		getTotalBreaks: getTotalBreaksMock,
	},
}))

vi.mock("../../prompts/sections/mcp-instructions-delta", () => ({
	clearMcpInstructionsDelta: clearMcpInstructionsDeltaMock,
}))

vi.mock("../../../services/cangjie-lsp/cangjieGeneratedTestCleanup", () => ({
	deleteGeneratedCangjieTestFilesForTask: deleteGeneratedCangjieTestFilesForTaskMock,
}))

vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: releaseTerminalsForTaskMock,
	},
}))

vi.mock("../../../integrations/terminal/OutputInterceptor", () => ({
	OutputInterceptor: {
		cleanup: outputCleanupMock,
	},
}))

import { TaskLifecycleHandler } from "../TaskLifecycleHandler"

function createHost(overrides: Record<string, unknown> = {}) {
	const provider = { off: vi.fn(), postMessageToWebview: vi.fn() }
	const host: any = {
		taskId: "task-1",
		instanceId: "instance-1",
		globalStoragePath: "D:\\storage",
		hostRef: { deref: () => provider },
		errorRecovery: { resetCompactFailure: vi.fn() },
		messageQueueService: {
			removeListener: vi.fn(),
			dispose: vi.fn(),
		},
		toolExecution: { dispose: vi.fn() },
		fileContextTracker: { dispose: vi.fn() },
		diffViewProvider: {
			isEditing: false,
			revertChanges: vi.fn().mockResolvedValue(undefined),
		},
		abort: false,
		abandoned: false,
		abortReason: undefined,
		isInitialized: false,
		isDisposed: false,
		isStreaming: false,
		consecutiveNoToolUseCount: 3,
		consecutiveNoAssistantMessagesCount: 4,
		persistentRetryHandler: { cancel: vi.fn() },
		providerProfileChangeListener: vi.fn(),
		messageQueueStateChangedHandler: vi.fn(),
		rooIgnoreController: { dispose: vi.fn() },
		clineMessages: [],
		apiConversationHistory: [],
		refreshWebviewState: vi.fn().mockResolvedValue(undefined),
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		emit: vi.fn(),
		getEnabledMcpToolsCount: vi.fn().mockResolvedValue({ enabledToolCount: 0, enabledServerCount: 0 }),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		initiateCloudAgentLoop: vi.fn().mockResolvedValue(undefined),
		initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
		getSavedClineMessages: vi.fn().mockResolvedValue([]),
		getSavedApiConversationHistory: vi.fn().mockResolvedValue([]),
		overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
		overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		saveClineMessages: vi.fn().mockResolvedValue(true),
		emitFinalTokenUsageUpdate: vi.fn(),
		dispose: vi.fn(),
		cancelCurrentRequest: vi.fn(),
		removeAllListeners: vi.fn(),
		provider,
		...overrides,
	}
	return host
}

describe("TaskLifecycleHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		getSummaryMock.mockReturnValue({
			totalRequests: 2,
			cacheHitRate: 0.5,
			totalCacheReadTokens: 10,
			totalCacheCreationTokens: 20,
			estimatedSavingsPercent: 0.25,
		})
		getBreaksBySourceMock.mockReturnValue({ system: 1 })
		getTotalBreaksMock.mockReturnValue(1)
		getTaskDirectoryPathMock.mockResolvedValue("D:\\storage\\tasks\\task-1")
		appendFileMock.mockResolvedValue(undefined)
		outputCleanupMock.mockResolvedValue(undefined)
	})

	it("starts default-mode tasks through the cloud agent loop", async () => {
		const host = createHost({ getTaskMode: vi.fn().mockResolvedValue("cloud-agent") })
		const handler = new TaskLifecycleHandler(host)

		await handler.startTask("hello", ["data:image/png;base64,aW1n"])

		expect(host.clineMessages).toEqual([])
		expect(host.apiConversationHistory).toEqual([])
		expect(host.refreshWebviewState).toHaveBeenCalled()
		expect(host.say).toHaveBeenCalledWith("text", "hello", ["data:image/png;base64,aW1n"])
		expect(host.isInitialized).toBe(true)
		expect(host.initiateCloudAgentLoop).toHaveBeenCalledWith("hello", ["data:image/png;base64,aW1n"])
		expect(host.initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("emits a too-many-tools warning during start", async () => {
		const host = createHost({
			getTaskMode: vi.fn().mockResolvedValue("cloud-agent"),
			getEnabledMcpToolsCount: vi.fn().mockResolvedValue({ enabledToolCount: 999, enabledServerCount: 5 }),
		})
		const handler = new TaskLifecycleHandler(host)

		await handler.startTask("hello")

		expect(host.say).toHaveBeenCalledWith(
			"too_many_tools_warning",
			expect.stringContaining('"toolCount":999'),
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true },
		)
	})

	it("starts non-default-mode tasks through the local task loop", async () => {
		const host = createHost({ getTaskMode: vi.fn().mockResolvedValue("cangjie") })
		const handler = new TaskLifecycleHandler(host)

		await handler.startTask("compile", [])

		expect(host.initiateCloudAgentLoop).not.toHaveBeenCalled()
		expect(host.initiateTaskLoop).toHaveBeenCalledWith([
			{ type: "text", text: "<user_message>\ncompile\n</user_message>" },
		])
	})

	it("suppresses start errors after user cancellation", async () => {
		const host = createHost({
			abortReason: "user_cancelled",
			initiateCloudAgentLoop: vi.fn().mockRejectedValue(new Error("cancelled")),
			getTaskMode: vi.fn().mockResolvedValue("cloud-agent"),
		})
		const handler = new TaskLifecycleHandler(host)

		await expect(handler.startTask("hello")).resolves.toBeUndefined()
	})

	it("aborts task state and disposes the host", async () => {
		const host = createHost()
		const handler = new TaskLifecycleHandler(host)

		await handler.abortTask(true)

		expect(host.abandoned).toBe(true)
		expect(host.abort).toBe(true)
		expect(host.persistentRetryHandler).toBeUndefined()
		expect(host.consecutiveNoToolUseCount).toBe(0)
		expect(host.consecutiveNoAssistantMessagesCount).toBe(0)
		expect(host.emitFinalTokenUsageUpdate).toHaveBeenCalled()
		expect(host.emit).toHaveBeenCalledWith(expect.any(String))
		expect(host.saveClineMessages).toHaveBeenCalled()
		expect(host.dispose).toHaveBeenCalled()
	})

	it("continues abort cleanup when save and dispose throw", async () => {
		const host = createHost({
			saveClineMessages: vi.fn().mockRejectedValue(new Error("save failed")),
			dispose: vi.fn(() => {
				throw new Error("dispose failed")
			}),
		})
		const handler = new TaskLifecycleHandler(host)

		await expect(handler.abortTask()).resolves.toBeUndefined()

		expect(host.abort).toBe(true)
		expect(host.dispose).toHaveBeenCalled()
	})

	it("disposes resources once and writes session metrics", async () => {
		const host = createHost()
		const handler = new TaskLifecycleHandler(host)

		handler.dispose()
		handler.dispose()
		await Promise.resolve()

		expect(host.isDisposed).toBe(true)
		expect(clearMcpInstructionsDeltaMock).toHaveBeenCalledWith("task-1")
		expect(deleteGeneratedCangjieTestFilesForTaskMock).toHaveBeenCalledWith("task-1")
		expect(host.cancelCurrentRequest).toHaveBeenCalledTimes(1)
		expect(host.provider.off).toHaveBeenCalled()
		expect(host.providerProfileChangeListener).toBeUndefined()
		expect(host.messageQueueService.removeListener).toHaveBeenCalledWith("stateChanged", expect.any(Function))
		expect(host.messageQueueService.dispose).toHaveBeenCalled()
		expect(host.removeAllListeners).toHaveBeenCalled()
		expect(releaseTerminalsForTaskMock).toHaveBeenCalledWith("task-1")
		expect(host.rooIgnoreController).toBeUndefined()
		expect(host.toolExecution.dispose).toHaveBeenCalled()
		expect(host.fileContextTracker.dispose).toHaveBeenCalled()
		expect(appendFileMock).toHaveBeenCalledWith(expect.stringContaining("task-metrics.jsonl"), expect.stringContaining('"trigger":"dispose"'), "utf8")
	})

	it("reverts an active diff view during streaming dispose", () => {
		const host = createHost({
			isStreaming: true,
			diffViewProvider: { isEditing: true, revertChanges: vi.fn().mockResolvedValue(undefined) },
		})
		const handler = new TaskLifecycleHandler(host)

		handler.dispose()

		expect(host.diffViewProvider.revertChanges).toHaveBeenCalled()
	})

	it("uses abort as metrics trigger when disposed after abort", async () => {
		const host = createHost({ abort: true })
		const handler = new TaskLifecycleHandler(host)

		handler.dispose()
		await Promise.resolve()

		expect(appendFileMock).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"trigger":"abort"'), "utf8")
	})

	it("resumes history by cleaning stale UI messages and continuing with default resume text", async () => {
		const savedClineMessages = [
			{ ts: 1, type: "say", say: "text", text: "old" },
			{ ts: 2, type: "say", say: "api_req_started", text: "{}" },
			{ ts: 3, type: "say", say: "reasoning", text: "thinking" },
			{ ts: 4, type: "ask", ask: "resume_task" },
		] as any[]
		const savedApi = [{ role: "assistant", content: "done" }] as any[]
		const host = createHost({
			getSavedClineMessages: vi.fn()
				.mockResolvedValueOnce(savedClineMessages)
				.mockResolvedValueOnce([{ ts: 1, type: "say", say: "text", text: "old" }]),
			getSavedApiConversationHistory: vi.fn()
				.mockResolvedValueOnce(savedApi)
				.mockResolvedValueOnce(savedApi),
		})
		const handler = new TaskLifecycleHandler(host)

		await handler.resumeTaskFromHistory()

		expect(host.overwriteClineMessages).toHaveBeenCalledWith([{ ts: 1, type: "say", say: "text", text: "old" }])
		expect(host.errorRecovery.resetCompactFailure).toHaveBeenCalled()
		expect(host.ask).toHaveBeenCalledWith("resume_task")
		expect(host.overwriteApiConversationHistory).toHaveBeenCalledWith(savedApi)
		expect(host.initiateTaskLoop).toHaveBeenCalledWith([
			{ type: "text", text: "[TASK RESUMPTION] Resuming task..." },
		])
	})

	it("resumes completed tasks with user feedback and images", async () => {
		const savedClineMessages = [{ ts: 1, type: "ask", ask: "completion_result" }] as any[]
		const savedApi = [{ role: "user", content: "old request" }] as any[]
		const host = createHost({
			getSavedClineMessages: vi.fn().mockResolvedValue(savedClineMessages),
			getSavedApiConversationHistory: vi.fn()
				.mockResolvedValueOnce(savedApi)
				.mockResolvedValueOnce(savedApi),
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "continue", images: ["data:image/png;base64,aW1n"] }),
		})
		const handler = new TaskLifecycleHandler(host)

		await handler.resumeTaskFromHistory()

		expect(host.ask).toHaveBeenCalledWith("resume_completed_task")
		expect(host.say).toHaveBeenCalledWith("user_feedback", "continue", ["data:image/png;base64,aW1n"])
		expect(host.overwriteApiConversationHistory).toHaveBeenCalledWith([])
		const newUserContent = host.initiateTaskLoop.mock.calls[0][0]
		expect(newUserContent[0]).toEqual({ type: "text", text: "old request" })
		expect(newUserContent[1]).toEqual({ type: "text", text: "<user_message>\ncontinue\n</user_message>" })
		expect(newUserContent.length).toBeGreaterThan(2)
	})

	it("adds interrupted tool results when resuming after assistant tool use", async () => {
		const assistant = {
			role: "assistant",
			content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: {} }],
		}
		const host = createHost({
			getSavedClineMessages: vi.fn().mockResolvedValue([{ ts: 1, type: "say", say: "text" }]),
			getSavedApiConversationHistory: vi.fn()
				.mockResolvedValueOnce([assistant])
				.mockResolvedValueOnce([assistant]),
		})
		const handler = new TaskLifecycleHandler(host)

		await handler.resumeTaskFromHistory()

		expect(host.initiateTaskLoop).toHaveBeenCalledWith([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "tool-1",
				content: expect.stringContaining("interrupted"),
			}),
		])
	})

	it("suppresses resume errors after abort", async () => {
		const host = createHost({
			abort: true,
			getSavedClineMessages: vi.fn().mockRejectedValue(new Error("read failed")),
		})
		const handler = new TaskLifecycleHandler(host)

		await expect(handler.resumeTaskFromHistory()).resolves.toBeUndefined()
	})
})
