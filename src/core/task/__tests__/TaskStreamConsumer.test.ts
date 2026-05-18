import { describe, it, expect, vi, beforeEach } from "vitest"

import { consumeApiStream, finalizeStreamResponse } from "../TaskStreamConsumer"
import type { ConsumeStreamConfig, FinalizeConfig, StackItem, FinalizeToolUseFn } from "../TaskStreamConsumer"
import type { TaskExecutorHost } from "../interfaces/ITaskExecutorHost"
import { TaskState } from "../TaskStateMachine"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

vi.mock("../../../shared/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock("../../../utils/debugLog", () => ({
	debugLog: vi.fn(),
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("../../../utils/queryProfiler", () => ({
	globalQueryProfiler: {
		start: vi.fn(),
		finish: vi.fn().mockReturnValue(undefined),
		markFirstToken: vi.fn(),
	},
}))

vi.mock("../../../utils/cacheMetrics", () => ({
	globalCacheMetrics: {
		record: vi.fn(),
		getSummary: vi.fn().mockReturnValue({
			cacheHitRate: 0,
			estimatedSavingsPercent: 0,
			totalRequests: 0,
		}),
	},
}))

vi.mock("../../prompts/promptCacheBreakDetection", () => ({
	globalPromptCacheBreakDetector: {
		getTotalBreaks: vi.fn().mockReturnValue(0),
		getBreaksBySource: vi.fn().mockReturnValue({}),
	},
}))

vi.mock("../../context-management", () => ({
	willManageContext: vi.fn().mockReturnValue(false),
}))

vi.mock("../TaskStreamChunkProcessor", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../TaskStreamChunkProcessor")>()
	return {
		...actual,
		processTaskStreamChunk: vi.fn().mockImplementation(async (options: any) => {
			const { chunk, appendReasoningText, appendAssistantText, addUsage, pendingGroundingSources } = options
			switch (chunk?.type) {
				case "text":
					appendAssistantText(chunk.text)
					break
				case "reasoning":
					appendReasoningText(chunk.text)
					break
				case "usage":
					addUsage(chunk)
					break
				case "grounding":
					if (chunk.sources) pendingGroundingSources.push(...chunk.sources)
					break
			}
		}),
		finalizePendingStreamingToolCalls: vi.fn().mockResolvedValue(undefined),
	}
})

vi.mock("../TaskRetryHandler", () => ({
	handleMidStreamFailure: vi.fn().mockResolvedValue("break"),
	handleEmptyAssistantResponse: vi.fn().mockResolvedValue("done"),
}))

vi.mock("../../assistant-message/streamState", () => ({
	markUserContentReadyIfDrained: vi.fn(),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => msg),
		toolRetryThrottled: vi.fn(() => "throttled"),
		noToolsUsed: vi.fn(() => "no tools"),
		noToolsUsedWithInterruptHint: vi.fn(() => "no tools interrupt"),
	},
}))

vi.mock("../../../shared/cost", () => ({
	calculateApiCostAnthropic: vi.fn().mockReturnValue({
		totalInputTokens: 100,
		totalOutputTokens: 50,
		totalCost: 0.01,
	}),
	calculateApiCostOpenAI: vi.fn().mockReturnValue({
		totalInputTokens: 100,
		totalOutputTokens: 50,
		totalCost: 0.01,
	}),
}))

vi.mock("../../../shared/tool-id", () => ({
	sanitizeToolUseId: vi.fn((id: string) => id),
}))

vi.mock("../../../shared/array", () => ({
	findLastIndex: vi.fn().mockReturnValue(-1),
}))

vi.mock("@njust-ai-cj/types", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@njust-ai-cj/types")>()
	return {
		...actual,
		clineApiReqInfoSchema: { parse: vi.fn().mockReturnValue({}) },
		DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT: 75,
		getApiProtocol: vi.fn().mockReturnValue("openai"),
		getModelId: vi.fn().mockReturnValue("gpt-4"),
		isRetiredProvider: vi.fn().mockReturnValue(false),
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

function createMockHost(overrides: Record<string, unknown> = {}): TaskExecutorHost {
	return {
		taskId: "test-task",
		instanceId: "inst-1",
		globalStoragePath: "/tmp",
		cwd: "/workspace",
		abort: false,
		abortReason: undefined,
		isPaused: false,
		isStreaming: false,
		isWaitingForFirstChunk: false,
		apiConfiguration: { apiProvider: "openai" } as any,
		api: {
			getModel: vi.fn().mockReturnValue({
				id: "gpt-4",
				info: { contextWindow: 128000, maxTokens: 4096 },
			}),
		} as any,
		apiConversationHistory: [],
		clineMessages: [],
		userMessageContent: [],
		assistantMessageContent: [],
		assistantMessageSavedToHistory: false,
		userMessageContentReady: true,
		currentStreamingContentIndex: 0,
		didCompleteReadingStream: false,
		stateMachine: { force: vi.fn(), state: TaskState.IDLE },
		hostRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({}),
				postMessageToWebview: vi.fn(),
				getSkillsManager: vi.fn(),
				handleModeSwitch: vi.fn(),
			}),
		} as any,
		requestBuilder: {
			prefetchSystemPromptData: vi.fn(),
			getSystemPromptParts: vi.fn(),
			getSystemPrompt: vi.fn(),
			condenseContext: vi.fn(),
			inheritCacheFromParent: vi.fn(),
		} as any,
		streamProcessor: {
			maybeWaitForProviderRateLimit: vi.fn(),
			backoffAndAnnounce: vi.fn(),
			buildCleanConversationHistory: vi.fn().mockReturnValue([]),
			getCurrentProfileId: vi.fn().mockReturnValue("default"),
			handleContextWindowExceededError: vi.fn(),
			getFilesReadByRooSafely: vi.fn().mockResolvedValue(undefined),
		} as any,
		errorRecovery: {
			handleApiError: vi.fn(),
			shouldBypassCondense: vi.fn().mockReturnValue(false),
			recordCompactFailure: vi.fn(),
			resetCompactFailure: vi.fn(),
		} as any,
		autoApprovalHandler: {
			checkAutoApprovalLimits: vi.fn().mockResolvedValue({ shouldProceed: true }),
		} as any,
		tokenGrowthTracker: {
			addSample: vi.fn(),
			getSnapshot: vi.fn().mockReturnValue(undefined),
		} as any,
		persistentRetryHandler: undefined,
		parentTask: undefined,
		rooIgnoreController: undefined,
		toolExecution: {
			dispose: vi.fn(),
			streamingExecutor: { shouldEagerExecute: vi.fn().mockReturnValue(null) },
		} as any,
		compactFailures: 0,
		requestCacheReadWindow: [],
		requestInputTokensWindow: [],
		cachedToolDefinitions: undefined,
		currentRequestAbortController: undefined,
		skipPrevResponseIdOnce: false,
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 0,
		didEditFile: false,
		abandoned: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		didToolFailInCurrentTurn: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		consecutiveNoToolUseCount: 0,
		consecutiveNoAssistantMessagesCount: 0,
		streamingToolCallIndices: new Map(),
		cachedStreamingModel: {
			id: "gpt-4",
			info: { contextWindow: 128000, maxTokens: 4096 },
		} as any,
		notifier: { postMessageToWebview: vi.fn() } as any,
		didFinishAbortingStream: false,
		currentStreamingDidCheckpoint: false,
		diffViewProvider: {
			isEditing: false,
			revertChanges: vi.fn(),
			reset: vi.fn().mockResolvedValue(undefined),
		} as any,
		fileContextTracker: {} as any,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		addToApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		pushToolResultToUserContent: vi.fn(),
		cancelCurrentRequest: vi.fn(),
		getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 1000 }),
		combineMessages: vi.fn().mockReturnValue([]),
		emit: vi.fn(),
		setLastGlobalApiRequestTime: vi.fn(),
		getLastGlobalApiRequestTime: vi.fn().mockReturnValue(0),
		saveClineMessages: vi.fn().mockResolvedValue(true),
		refreshWebviewState: vi.fn().mockResolvedValue(undefined),
		updateClineMessage: vi.fn().mockResolvedValue(undefined),
		abortTask: vi.fn().mockResolvedValue(undefined),
		backoffAndAnnounce: vi.fn().mockResolvedValue(undefined),
		maybeWaitForProviderRateLimit: vi.fn().mockResolvedValue(undefined),
		attemptApiRequest: vi.fn(),
		presentAssistantMessage: vi.fn().mockResolvedValue(undefined),
		getTaskMode: vi.fn().mockResolvedValue("code"),
		...overrides,
	} as any as TaskExecutorHost
}

async function* createAsyncStream(chunks: any[]): AsyncGenerator<any> {
	for (const chunk of chunks) {
		yield chunk
	}
}

const noopFinalizeToolUse: FinalizeToolUseFn = (_task, id, toolUse) => {
	toolUse.id = id
	return toolUse
}

describe("TaskStreamConsumer — consumeApiStream", () => {
	let mockHost: TaskExecutorHost
	let toolCallParser: NativeToolCallParser

	beforeEach(() => {
		vi.clearAllMocks()
		mockHost = createMockHost()
		toolCallParser = new NativeToolCallParser()
	})

	it("正常消费文本流并返回 assistantMessage", async () => {
		const stream = createAsyncStream([
			{ type: "text", text: "Hello " },
			{ type: "text", text: "World" },
			{ type: "usage", inputTokens: 10, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0 },
		])

		const result = await consumeApiStream({
			task: mockHost,
			stream,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-1",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(result.assistantMessage).toBe("Hello World")
		expect(result.reasoningMessage).toBe("")
	})

	it("正常消费 reasoning + text 流", async () => {
		const stream = createAsyncStream([
			{ type: "reasoning", text: "Let me think..." },
			{ type: "text", text: "The answer is 42" },
		])

		const result = await consumeApiStream({
			task: mockHost,
			stream,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-2",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(result.reasoningMessage).toBe("Let me think...")
		expect(result.assistantMessage).toBe("The answer is 42")
	})

	it("abort 时中断流并返回 proceed", async () => {
		const host = createMockHost()
		let callCount = 0
		async function* abortStream() {
			yield { type: "text", text: "partial" }
			;(host as any).abort = true
			yield { type: "text", text: " should not appear" }
		}

		const result = await consumeApiStream({
			task: host,
			stream: abortStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-abort",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(result.assistantMessage).toContain("partial")
	})

	it("didRejectTool 时中断流", async () => {
		const host = createMockHost()
		async function* rejectStream() {
			yield { type: "text", text: "starting..." }
			;(host as any).didRejectTool = true
			yield { type: "text", text: " ignored" }
		}

		const result = await consumeApiStream({
			task: host,
			stream: rejectStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-reject",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(result.assistantMessage).toContain("interrupted by user feedback")
	})

	it("流异常时委托给 handleMidStreamFailure 返回 continue", async () => {
		const { handleMidStreamFailure } = await import("../TaskRetryHandler")
		;(handleMidStreamFailure as any).mockResolvedValueOnce("continue")

		const stack: StackItem[] = []
		async function* errorStream() {
			yield { type: "text", text: "partial" }
			throw new Error("Stream error")
		}

		const result = await consumeApiStream({
			task: mockHost,
			stream: errorStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-error",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [{ type: "text", text: "user msg" }],
			stack,
		})

		expect(result.action).toBe("continue")
	})

	it("流异常时委托给 handleMidStreamFailure 返回 break", async () => {
		const { handleMidStreamFailure } = await import("../TaskRetryHandler")
		;(handleMidStreamFailure as any).mockResolvedValueOnce("break")

		async function* errorStream() {
			throw new Error("Stream error")
		}

		const result = await consumeApiStream({
			task: mockHost,
			stream: errorStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-brk",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("break")
	})

	it("abandoned 时流异常返回 proceed（不调用 handleMidStreamFailure）", async () => {
		const host = createMockHost({ abandoned: true })
		const { handleMidStreamFailure } = await import("../TaskRetryHandler")

		async function* errorStream() {
			throw new Error("Stream error")
		}

		const result = await consumeApiStream({
			task: host,
			stream: errorStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-abandoned",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(handleMidStreamFailure).not.toHaveBeenCalled()
	})

	it("跳过 undefined chunk", async () => {
		const host = createMockHost()
		async function* sparseStream() {
			yield undefined
			yield { type: "text", text: "valid" }
		}

		const result = await consumeApiStream({
			task: host,
			stream: sparseStream(),
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-sparse",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.action).toBe("proceed")
		expect(result.assistantMessage).toBe("valid")
	})

	it("处理 grounding 源", async () => {
		const stream = createAsyncStream([
			{ type: "grounding", sources: [{ url: "https://example.com/1" }, { url: "https://example.com/2" }] },
			{ type: "text", text: "result" },
		])

		const result = await consumeApiStream({
			task: mockHost,
			stream,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "test-req-grounding",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(result.pendingGroundingSources).toHaveLength(2)
		expect(result.pendingGroundingSources[0].url).toBe("https://example.com/1")
	})
})

describe("TaskStreamConsumer — finalizeStreamResponse", () => {
	let mockHost: TaskExecutorHost
	let toolCallParser: NativeToolCallParser

	beforeEach(() => {
		vi.clearAllMocks()
		mockHost = createMockHost()
		toolCallParser = new NativeToolCallParser()
	})

	it("有文本内容时构建助手消息并保存到历史", async () => {
		const host = createMockHost()

		const result = await finalizeStreamResponse({
			task: host,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: {
				assistantMessage: "Hello!",
				reasoningMessage: "",
				pendingGroundingSources: [],
				action: "proceed",
			},
			requestProfileId: "test-finalize-1",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(host.addToApiConversationHistory).toHaveBeenCalled()
		expect(result.action).toBe("continue")
	})

	it("abort 时抛出错误", async () => {
		const host = createMockHost({ abort: true })

		await expect(
			finalizeStreamResponse({
				task: host,
				toolCallParser,
				placeFinalizedStreamingToolUse: noopFinalizeToolUse,
				consumptionResult: {
					assistantMessage: "",
					reasoningMessage: "",
					pendingGroundingSources: [],
					action: "proceed",
				},
				requestProfileId: "test-finalize-abort",
				lastApiReqIndex: -1,
				retryAttempt: 0,
				currentUserContent: [],
				stack: [],
			}),
		).rejects.toThrow("aborted")
	})

	it("abandoned 时抛出错误", async () => {
		const host = createMockHost({ abandoned: true })

		await expect(
			finalizeStreamResponse({
				task: host,
				toolCallParser,
				placeFinalizedStreamingToolUse: noopFinalizeToolUse,
				consumptionResult: {
					assistantMessage: "",
					reasoningMessage: "",
					pendingGroundingSources: [],
					action: "proceed",
				},
				requestProfileId: "test-finalize-abandoned",
				lastApiReqIndex: -1,
				retryAttempt: 0,
				currentUserContent: [],
				stack: [],
			}),
		).rejects.toThrow("aborted")
	})

	it("空响应时委托给 handleEmptyAssistantResponse", async () => {
		const { handleEmptyAssistantResponse } = await import("../TaskRetryHandler")
		;(handleEmptyAssistantResponse as any).mockResolvedValueOnce("continue")

		const host = createMockHost()

		const result = await finalizeStreamResponse({
			task: host,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: {
				assistantMessage: "",
				reasoningMessage: "",
				pendingGroundingSources: [],
				action: "proceed",
			},
			requestProfileId: "test-finalize-empty",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(handleEmptyAssistantResponse).toHaveBeenCalled()
		expect(result.action).toBe("continue")
	})

	it("有 grounding 源时输出引用链接", async () => {
		const host = createMockHost()

		const result = await finalizeStreamResponse({
			task: host,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: {
				assistantMessage: "Here are sources:",
				reasoningMessage: "",
				pendingGroundingSources: [
					{ url: "https://example.com/1" },
					{ url: "https://example.com/2" },
				],
				action: "proceed",
			},
			requestProfileId: "test-finalize-grounding",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(host.say).toHaveBeenCalledWith("text", expect.stringContaining("[1]"), undefined, false, undefined, undefined, { isNonInteractive: true })
		expect(result.action).toBe("continue")
	})

	it("设置 didCompleteReadingStream 为 true", async () => {
		const host = createMockHost()

		await finalizeStreamResponse({
			task: host,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: {
				assistantMessage: "done",
				reasoningMessage: "",
				pendingGroundingSources: [],
				action: "proceed",
			},
			requestProfileId: "test-finalize-complete",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(host.didCompleteReadingStream).toBe(true)
	})

	it("有工具使用时重置 consecutiveNoToolUseCount", async () => {
		const host = createMockHost({ consecutiveNoToolUseCount: 2 })
		;(host as any).assistantMessageContent = [
			{ type: "tool_use", name: "read_file", params: {}, id: "tu_1" },
		]

		await finalizeStreamResponse({
			task: host,
			toolCallParser,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: {
				assistantMessage: "using tool",
				reasoningMessage: "",
				pendingGroundingSources: [],
				action: "proceed",
			},
			requestProfileId: "test-finalize-tooluse",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(host.consecutiveNoToolUseCount).toBe(0)
	})
})

describe("TaskStreamConsumer — 状态机集成", () => {
	it("完整流程: 文本流 → 消费 → 终结 → 保存历史", async () => {
		const host = createMockHost()
		const tcp = new NativeToolCallParser()

		const stream = createAsyncStream([
			{ type: "text", text: "I will help you." },
			{ type: "usage", inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0 },
		])

		const consumption = await consumeApiStream({
			task: host,
			stream,
			toolCallParser: tcp,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "integration-1",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(consumption.action).toBe("proceed")
		expect(consumption.assistantMessage).toBe("I will help you.")

		const finalize = await finalizeStreamResponse({
			task: host,
			toolCallParser: tcp,
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			consumptionResult: consumption,
			requestProfileId: "integration-1",
			lastApiReqIndex: -1,
			retryAttempt: 0,
			currentUserContent: [],
			stack: [],
		})

		expect(finalize.action).toBe("continue")
		expect(host.addToApiConversationHistory).toHaveBeenCalledWith(
			expect.objectContaining({ role: "assistant" }),
			undefined,
		)
		expect(host.didCompleteReadingStream).toBe(true)
	})

	it("异常流程: 流错误 → mid-stream 重试 → continue", async () => {
		const { handleMidStreamFailure } = await import("../TaskRetryHandler")
		;(handleMidStreamFailure as any).mockResolvedValueOnce("continue")

		const host = createMockHost()
		const stack: StackItem[] = []

		async function* errorStream() {
			yield { type: "text", text: "start" }
			throw new Error("connection reset")
		}

		const result = await consumeApiStream({
			task: host,
			stream: errorStream(),
			toolCallParser: new NativeToolCallParser(),
			placeFinalizedStreamingToolUse: noopFinalizeToolUse,
			requestProfileId: "integration-error",
			lastApiReqIndex: -1,
			requestStartedAt: Date.now(),
			retryAttempt: 0,
			currentUserContent: [{ type: "text", text: "retry me" }],
			stack,
		})

		expect(result.action).toBe("continue")
		expect(handleMidStreamFailure).toHaveBeenCalledWith(
			expect.objectContaining({
				currentRetryAttempt: 0,
				currentUserContent: [{ type: "text", text: "retry me" }],
			}),
		)
	})
})
