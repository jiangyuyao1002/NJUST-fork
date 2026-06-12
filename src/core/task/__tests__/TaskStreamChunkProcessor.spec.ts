import { describe, it, expect, vi, beforeEach } from "vitest"

import { processTaskStreamChunk, finalizePendingStreamingToolCalls } from "../TaskStreamChunkProcessor"
import type { ProcessTaskStreamChunkOptions } from "../TaskStreamChunkProcessor"
import type { TaskExecutorHost } from "../interfaces/ITaskExecutorHost"
import type { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { GroundingSource } from "../../../api/transform/stream"
import type { ToolUse, McpToolUse } from "../../../shared/tools"

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../../shared/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock("../../../utils/queryProfiler", () => ({
	globalQueryProfiler: {
		start: vi.fn(),
		finish: vi.fn().mockReturnValue(undefined),
		markFirstToken: vi.fn(),
	},
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
	},
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: {
		UTILITY_ERROR: "utility_error",
	},
}))

vi.mock("../../assistant-message/NativeToolCallParser", () => ({
	NativeToolCallParser: {
		parseToolCall: vi.fn(),
	},
}))

// ── Helpers ────────────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<TaskExecutorHost> = {}): TaskExecutorHost {
	return {
		taskId: "test-task-123",
		instanceId: "inst-1",
		globalStoragePath: "/tmp",
		cwd: "/workspace",
		abort: false,
		taskCompleted: false,
		isPaused: false,
		isStreaming: true,
		isWaitingForFirstChunk: false,
		apiConfiguration: {} as any,
		api: {} as any,
		apiConversationHistory: [],
		clineMessages: [],
		userMessageContent: [],
		assistantMessageContent: [],
		assistantMessageSavedToHistory: false,
		userMessageContentReady: false,
		currentStreamingContentIndex: 0,
		didCompleteReadingStream: false,
		stateMachine: { force: vi.fn(), state: "idle" as any },
		hostRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					enableStreamingToolExecution: true,
					autoApprovalEnabled: false,
				}),
			}),
		} as any,
		requestBuilder: {} as any,
		streamProcessor: {} as any,
		errorRecovery: {} as any,
		autoApprovalHandler: {} as any,
		tokenGrowthTracker: {} as any,
		persistentRetryHandler: undefined,
		parentTask: undefined,
		rooIgnoreController: undefined,
		toolExecution: {
			dispose: vi.fn(),
			streamingExecutor: { shouldEagerExecute: vi.fn().mockReturnValue(null) },
		},
		compactFailureCount: 0,
		requestCacheReadWindow: [],
		requestInputTokensWindow: [],
		cachedToolDefinitions: undefined,
		currentRequestAbortController: undefined,
		skipPrevResponseIdOnce: false,
		consecutiveMistakeCount: 0,
		consecutiveMistakeLimit: 3,
		didEditFile: false,
		abandoned: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		didToolFailInCurrentTurn: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		consecutiveNoToolUseCount: 0,
		consecutiveNoAssistantMessagesCount: 0,
		streamingToolCallIndices: new Map<string, number>(),
		didFinishAbortingStream: false,
		currentStreamingDidCheckpoint: false,
		diffViewProvider: {} as any,
		fileContextTracker: {} as any,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "" }),
		addToApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		pushToolResultToUserContent: vi.fn().mockReturnValue(true),
		cancelCurrentRequest: vi.fn(),
		getTokenUsage: vi.fn().mockReturnValue({}),
		combineMessages: vi.fn().mockReturnValue([]),
		emit: vi.fn().mockReturnValue(true),
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
		getTaskMode: vi.fn().mockReturnValue("code"),
		...overrides,
	} as TaskExecutorHost
}

function createMockToolCallParser(overrides: Partial<NativeToolCallParser> = {}): NativeToolCallParser {
	return {
		processRawChunk: vi.fn().mockReturnValue([]),
		startStreamingToolCall: vi.fn(),
		processStreamingChunk: vi.fn().mockReturnValue(null),
		finalizeStreamingToolCall: vi.fn().mockReturnValue(null),
		finalizeRawChunks: vi.fn().mockReturnValue([]),
		parseToolCall: vi.fn(),
		...overrides,
	} as unknown as NativeToolCallParser
}

function createOptions(overrides: Partial<ProcessTaskStreamChunkOptions> = {}): ProcessTaskStreamChunkOptions {
	return {
		task: createMockTask(),
		chunk: { type: "text", text: "hello" },
		toolCallParser: createMockToolCallParser(),
		requestProfileId: "profile-1",
		pendingGroundingSources: [],
		finalizeToolUse: vi.fn((_, __, finalToolUse) => finalToolUse),
		appendReasoningText: vi.fn((text: string) => text),
		appendAssistantText: vi.fn((text: string) => text),
		addUsage: vi.fn(),
		...overrides,
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("processTaskStreamChunk", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// ── text chunks ─────────────────────────────────────────────────────

	describe("text chunk", () => {
		it("appends assistant text and creates a new text content block", async () => {
			const opts = createOptions({
				chunk: { type: "text", text: "hello world" },
			})
			const { task, appendAssistantText } = opts

			await processTaskStreamChunk(opts)

			expect(appendAssistantText).toHaveBeenCalledWith("hello world")
			expect(task.assistantMessageContent).toHaveLength(1)
			expect(task.assistantMessageContent[0]).toMatchObject({
				type: "text",
				content: "hello world",
				partial: true,
			})
			expect(task.userMessageContentReady).toBe(false)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("updates existing partial text block instead of creating a new one", async () => {
			const task = createMockTask({
				assistantMessageContent: [{ type: "text", content: "old", partial: true }],
			})
			const opts = createOptions({
				task,
				chunk: { type: "text", text: "updated" },
				appendAssistantText: vi.fn(() => "full updated text"),
			})

			await processTaskStreamChunk(opts)

			expect(task.assistantMessageContent).toHaveLength(1)
			expect(task.assistantMessageContent[0]).toMatchObject({
				type: "text",
				content: "full updated text",
				partial: true,
			})
		})

		it("creates a new block when last block is text but not partial", async () => {
			const task = createMockTask({
				assistantMessageContent: [{ type: "text", content: "done", partial: false }],
			})
			const opts = createOptions({
				task,
				chunk: { type: "text", text: "new" },
			})

			await processTaskStreamChunk(opts)

			expect(task.assistantMessageContent).toHaveLength(2)
			expect(task.assistantMessageContent[1]).toMatchObject({
				type: "text",
				content: "new",
				partial: true,
			})
		})

		it("marks first token via globalQueryProfiler", async () => {
			const { globalQueryProfiler } = await import("../../../utils/queryProfiler")
			const opts = createOptions({
				chunk: { type: "text", text: "hi" },
				requestProfileId: "req-42",
			})

			await processTaskStreamChunk(opts)

			expect(globalQueryProfiler.markFirstToken).toHaveBeenCalledWith("req-42")
		})
	})

	// ── reasoning chunks ────────────────────────────────────────────────

	describe("reasoning chunk", () => {
		it("appends reasoning text and calls task.say", async () => {
			const opts = createOptions({
				chunk: { type: "reasoning", text: "thinking hard" },
			})
			const { task, appendReasoningText } = opts

			await processTaskStreamChunk(opts)

			expect(appendReasoningText).toHaveBeenCalledWith("thinking hard")
			expect(task.say).toHaveBeenCalledWith("reasoning", "thinking hard", undefined, true)
		})

		it("formats bold headings in reasoning text", async () => {
			const opts = createOptions({
				chunk: { type: "reasoning", text: "Some text.**Bold Heading**" },
				appendReasoningText: vi.fn(() => "Some text.**Bold Heading**"),
			})
			const { task } = opts

			await processTaskStreamChunk(opts)

			expect(task.say).toHaveBeenCalledWith("reasoning", "Some text.\n\n**Bold Heading**", undefined, true)
		})

		it("does not reformat reasoning text without bold markers", async () => {
			const opts = createOptions({
				chunk: { type: "reasoning", text: "plain reasoning" },
				appendReasoningText: vi.fn(() => "plain reasoning"),
			})
			const { task } = opts

			await processTaskStreamChunk(opts)

			expect(task.say).toHaveBeenCalledWith("reasoning", "plain reasoning", undefined, true)
		})
	})

	// ── usage chunks ────────────────────────────────────────────────────

	describe("usage chunk", () => {
		it("calls addUsage with the chunk", async () => {
			const usageChunk = {
				type: "usage" as const,
				inputTokens: 100,
				outputTokens: 50,
			}
			const opts = createOptions({ chunk: usageChunk })

			await processTaskStreamChunk(opts)

			expect(opts.addUsage).toHaveBeenCalledWith(usageChunk)
		})
	})

	// ── grounding chunks ────────────────────────────────────────────────

	describe("grounding chunk", () => {
		it("pushes sources to pendingGroundingSources", async () => {
			const sources: GroundingSource[] = [
				{ title: "Doc 1", url: "https://example.com/1" },
				{ title: "Doc 2", url: "https://example.com/2", snippet: "some snippet" },
			]
			const pendingSources: GroundingSource[] = []
			const opts = createOptions({
				chunk: { type: "grounding", sources },
				pendingGroundingSources: pendingSources,
			})

			await processTaskStreamChunk(opts)

			expect(pendingSources).toHaveLength(2)
			expect(pendingSources[0]).toEqual(sources[0])
			expect(pendingSources[1]).toEqual(sources[1])
		})

		it("does not push when sources array is empty", async () => {
			const pendingSources: GroundingSource[] = []
			const opts = createOptions({
				chunk: { type: "grounding", sources: [] },
				pendingGroundingSources: pendingSources,
			})

			await processTaskStreamChunk(opts)

			expect(pendingSources).toHaveLength(0)
		})

		it("does not push when sources is undefined", async () => {
			const pendingSources: GroundingSource[] = []
			const opts = createOptions({
				chunk: { type: "grounding", sources: undefined as any },
				pendingGroundingSources: pendingSources,
			})

			await processTaskStreamChunk(opts)

			expect(pendingSources).toHaveLength(0)
		})
	})

	// ── tool_call chunks ────────────────────────────────────────────────

	describe("tool_call chunk", () => {
		it("parses and pushes a valid tool call to assistantMessageContent", async () => {
			const parsedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: { path: "/foo.ts" },
				partial: false,
			}
			vi.mocked(
				(await import("../../assistant-message/NativeToolCallParser")).NativeToolCallParser.parseToolCall,
			).mockReturnValue(parsedToolUse)

			const task = createMockTask()
			const opts = createOptions({
				task,
				chunk: { type: "tool_call", id: "tc-1", name: "read_file", arguments: '{"path":"/foo.ts"}' },
			})

			await processTaskStreamChunk(opts)

			expect(task.assistantMessageContent).toHaveLength(1)
			expect(task.assistantMessageContent[0]).toMatchObject({
				type: "tool_use",
				name: "read_file",
			})
			expect((task.assistantMessageContent[0] as any).id).toBe("tc-1")
			expect(task.userMessageContentReady).toBe(false)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("logs error and does not push when parseToolCall returns null", async () => {
			const { logger } = await import("../../../shared/logger")
			vi.mocked(
				(await import("../../assistant-message/NativeToolCallParser")).NativeToolCallParser.parseToolCall,
			).mockReturnValue(null)

			const task = createMockTask()
			const opts = createOptions({
				task,
				chunk: { type: "tool_call", id: "tc-bad", name: "unknown_tool", arguments: "bad" },
			})

			await processTaskStreamChunk(opts)

			expect(logger.error).toHaveBeenCalled()
			expect(task.assistantMessageContent).toHaveLength(0)
			expect(task.presentAssistantMessage).not.toHaveBeenCalled()
		})
	})

	// ── tool_call_partial chunks ────────────────────────────────────────

	describe("tool_call_partial chunk", () => {
		it("handles tool_call_start event: creates partial tool use and tracks index", async () => {
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi
					.fn()
					.mockReturnValue([{ type: "tool_call_start", id: "tc-s1", name: "write_to_file" }]),
			}) as any
			const task = createMockTask()
			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_partial", index: 0, id: "tc-s1", name: "write_to_file" },
			})

			await processTaskStreamChunk(opts)

			expect(toolCallParser.startStreamingToolCall).toHaveBeenCalledWith("tc-s1", "write_to_file")
			expect(task.streamingToolCallIndices.has("tc-s1")).toBe(true)
			expect(task.assistantMessageContent).toHaveLength(1)
			expect(task.assistantMessageContent[0]).toMatchObject({
				type: "tool_use",
				name: "write_to_file",
				partial: true,
			})
			expect(task.userMessageContentReady).toBe(false)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("ignores duplicate tool_call_start for the same id", async () => {
			const { logger } = await import("../../../shared/logger")
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi
					.fn()
					.mockReturnValue([{ type: "tool_call_start", id: "dup-id", name: "read_file" }]),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("dup-id", 0)

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_partial", index: 0, id: "dup-id", name: "read_file" },
			})

			await processTaskStreamChunk(opts)

			expect(logger.warn).toHaveBeenCalledWith("TaskExecutor", expect.stringContaining("dup-id"))
			expect(toolCallParser.startStreamingToolCall).not.toHaveBeenCalled()
		})

		it("marks preceding partial text block as non-partial on tool_call_start", async () => {
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi
					.fn()
					.mockReturnValue([{ type: "tool_call_start", id: "tc-t1", name: "list_files" }]),
			}) as any
			const task = createMockTask({
				assistantMessageContent: [{ type: "text", content: "some text", partial: true }],
			})

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_partial", index: 0, id: "tc-t1", name: "list_files" },
			})

			await processTaskStreamChunk(opts)

			expect(task.assistantMessageContent[0]).toMatchObject({
				type: "text",
				partial: false,
			})
		})

		it("handles tool_call_delta event: updates existing tool use in content", async () => {
			const partialToolUse: ToolUse = {
				type: "tool_use",
				name: "write_to_file" as any,
				params: { path: "/f" },
				partial: true,
			}
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi
					.fn()
					.mockReturnValue([{ type: "tool_call_delta", id: "tc-d1", delta: '{"path":"/f' }]),
				processStreamingChunk: vi.fn().mockReturnValue(partialToolUse),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("tc-d1", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "write_to_file" as any, params: {}, partial: true } as ToolUse,
			]

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_partial", index: 0, arguments: '{"path":"/f' },
			})

			await processTaskStreamChunk(opts)

			expect(toolCallParser.processStreamingChunk).toHaveBeenCalledWith("tc-d1", '{"path":"/f')
			expect(task.assistantMessageContent[0]).toBe(partialToolUse)
			expect((task.assistantMessageContent[0] as any).id).toBe("tc-d1")
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("skips tool_call_delta when processStreamingChunk returns null", async () => {
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi.fn().mockReturnValue([{ type: "tool_call_delta", id: "tc-d2", delta: "x" }]),
				processStreamingChunk: vi.fn().mockReturnValue(null),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("tc-d2", 0)

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_partial", index: 0, arguments: "x" },
			})

			await processTaskStreamChunk(opts)

			expect(task.presentAssistantMessage).not.toHaveBeenCalled()
		})

		it("handles tool_call_end event from processRawChunk: delegates to handleFinalToolCall", async () => {
			const finalizedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: { path: "/done.ts" },
				partial: false,
			}
			const toolCallParser = createMockToolCallParser({
				processRawChunk: vi.fn().mockReturnValue([{ type: "tool_call_end", id: "tc-e1" }]),
				finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("tc-e1", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			]

			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)
			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_partial", index: 0 },
			})

			await processTaskStreamChunk(opts)

			expect(toolCallParser.finalizeStreamingToolCall).toHaveBeenCalledWith("tc-e1")
			expect(finalizeToolUse).toHaveBeenCalled()
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})
	})

	// ── tool_call_end chunks ────────────────────────────────────────────

	describe("tool_call_end chunk", () => {
		it("finalizes tool call and calls presentAssistantMessage", async () => {
			const finalizedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: { path: "/x.ts" },
				partial: false,
			}
			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("end-1", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			]

			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)
			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_end", id: "end-1" },
			})

			await processTaskStreamChunk(opts)

			expect(toolCallParser.finalizeStreamingToolCall).toHaveBeenCalledWith("end-1")
			expect(finalizeToolUse).toHaveBeenCalledWith(task, "end-1", finalizedToolUse)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("returns early when finalizeStreamingToolCall returns null and no index tracked", async () => {
			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(null),
			}) as any
			const task = createMockTask()
			// No streamingToolCallIndices entry for "end-2"

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_end", id: "end-2" },
			})

			await processTaskStreamChunk(opts)

			expect(task.presentAssistantMessage).not.toHaveBeenCalled()
		})

		it("marks existing partial tool_use as non-partial when finalize returns null", async () => {
			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(null),
			}) as any
			const task = createMockTask()
			const existingToolUse: ToolUse = {
				type: "tool_use",
				name: "list_files" as any,
				params: {},
				partial: true,
			}
			task.streamingToolCallIndices.set("end-3", 0)
			task.assistantMessageContent = [existingToolUse]

			const opts = createOptions({
				task,
				toolCallParser,
				chunk: { type: "tool_call_end", id: "end-3" },
			})

			await processTaskStreamChunk(opts)

			expect(existingToolUse.partial).toBe(false)
			expect((existingToolUse as any).id).toBe("end-3")
			expect(task.streamingToolCallIndices.has("end-3")).toBe(false)
			expect(task.userMessageContentReady).toBe(false)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("triggers eager execution when conditions are met", async () => {
			const finalizedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: { path: "/eager.ts" },
				partial: false,
			}
			const task = createMockTask({
				toolExecution: {
					dispose: vi.fn(),
					streamingExecutor: {
						shouldEagerExecute: vi.fn().mockReturnValue("eager"),
					},
				},
				hostRef: {
					deref: vi.fn().mockReturnValue({
						getState: vi.fn().mockResolvedValue({
							enableStreamingToolExecution: true,
							autoApprovalEnabled: true,
						}),
					}),
				} as any,
			})
			task.streamingToolCallIndices.set("eager-1", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			]

			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
			}) as any
			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)

			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_end", id: "eager-1" },
			})

			await processTaskStreamChunk(opts)

			expect(task.toolExecution.streamingExecutor.shouldEagerExecute).toHaveBeenCalled()
			// presentAssistantMessage is called for the eager path
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("does NOT trigger eager execution when autoApprovalEnabled is false", async () => {
			const finalizedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: {},
				partial: false,
			}
			const task = createMockTask({
				hostRef: {
					deref: vi.fn().mockReturnValue({
						getState: vi.fn().mockResolvedValue({
							enableStreamingToolExecution: true,
							autoApprovalEnabled: false,
						}),
					}),
				} as any,
			})
			task.streamingToolCallIndices.set("no-eager", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			]

			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
			}) as any
			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)

			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_end", id: "no-eager" },
			})

			await processTaskStreamChunk(opts)

			expect(task.toolExecution.streamingExecutor.shouldEagerExecute).not.toHaveBeenCalled()
		})
	})

	// ── presentAssistantMessage error handling ──────────────────────────

	describe("presentAssistantMessage error handling", () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it("catches errors from presentAssistantMessage and logs them", async () => {
			const { TelemetryService } = await import("@njust-ai/telemetry")
			const error = new Error("present failed")
			const task = createMockTask({
				presentAssistantMessage: vi.fn().mockRejectedValue(error),
			})

			const opts = createOptions({
				task,
				chunk: { type: "text", text: "trigger" },
			})

			// Should not throw
			await processTaskStreamChunk(opts)

			// Give the fire-and-forget promise time to resolve
			await vi.advanceTimersByTimeAsync(10)

			const { logger } = await import("../../../shared/logger")
			expect(logger.error).toHaveBeenCalledWith("presentAssistantMessage failed", error)
			expect(TelemetryService.reportError).toHaveBeenCalled()
		})
	})

	// ── maybeEagerExecuteFinalTool edge cases ───────────────────────────

	describe("maybeEagerExecuteFinalTool edge cases", () => {
		it("returns false for non-tool_use types", async () => {
			const mcpToolUse: McpToolUse = {
				type: "mcp_tool_use",
				name: "mcp_tool" as any,
				serverName: "server",
				toolName: "tool",
				params: {},
				partial: false,
			}
			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(mcpToolUse),
			}) as any
			const task = createMockTask()
			task.streamingToolCallIndices.set("mcp-1", 0)
			task.assistantMessageContent = [mcpToolUse]

			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)
			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_end", id: "mcp-1" },
			})

			await processTaskStreamChunk(opts)

			// shouldEagerExecute should not be called for mcp_tool_use
			expect(task.toolExecution.streamingExecutor.shouldEagerExecute).not.toHaveBeenCalled()
			// But presentAssistantMessage should still be called (normal path)
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})

		it("treats undefined state as enabled (default true)", async () => {
			const finalizedToolUse: ToolUse = {
				type: "tool_use",
				name: "read_file" as any,
				params: {},
				partial: false,
			}
			const task = createMockTask({
				hostRef: {
					deref: vi.fn().mockReturnValue({
						getState: vi.fn().mockResolvedValue(undefined),
					}),
				} as any,
				toolExecution: {
					dispose: vi.fn(),
					streamingExecutor: {
						shouldEagerExecute: vi.fn().mockReturnValue(null),
					},
				},
			})
			task.streamingToolCallIndices.set("undef-state", 0)
			task.assistantMessageContent = [
				{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			]

			const toolCallParser = createMockToolCallParser({
				finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
			}) as any
			const finalizeToolUse = vi.fn((_, __, ftu) => ftu)

			const opts = createOptions({
				task,
				toolCallParser,
				finalizeToolUse,
				chunk: { type: "tool_call_end", id: "undef-state" },
			})

			await processTaskStreamChunk(opts)

			// autoApprovalEnabled defaults to false (?? false), so eager won't trigger
			expect(task.toolExecution.streamingExecutor.shouldEagerExecute).not.toHaveBeenCalled()
			expect(task.presentAssistantMessage).toHaveBeenCalled()
		})
	})
})

// ── finalizePendingStreamingToolCalls ───────────────────────────────────

describe("finalizePendingStreamingToolCalls", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("processes tool_call_end events from finalizeRawChunks", async () => {
		const finalizedToolUse: ToolUse = {
			type: "tool_use",
			name: "read_file" as any,
			params: { path: "/final.ts" },
			partial: false,
		}
		const toolCallParser = createMockToolCallParser({
			finalizeRawChunks: vi.fn().mockReturnValue([{ type: "tool_call_end", id: "fin-1" }]),
			finalizeStreamingToolCall: vi.fn().mockReturnValue(finalizedToolUse),
		}) as any
		const task = createMockTask()
		task.streamingToolCallIndices.set("fin-1", 0)
		task.assistantMessageContent = [
			{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
		]

		const finalizeToolUse = vi.fn((_, __, ftu) => ftu)

		await finalizePendingStreamingToolCalls({
			task,
			toolCallParser,
			finalizeToolUse,
		})

		expect(toolCallParser.finalizeRawChunks).toHaveBeenCalled()
		expect(toolCallParser.finalizeStreamingToolCall).toHaveBeenCalledWith("fin-1")
		expect(finalizeToolUse).toHaveBeenCalled()
	})

	it("handles multiple tool_call_end events", async () => {
		const toolUse1: ToolUse = { type: "tool_use", name: "read_file" as any, params: {}, partial: false }
		const toolUse2: ToolUse = { type: "tool_use", name: "list_files" as any, params: {}, partial: false }

		const toolCallParser = createMockToolCallParser({
			finalizeRawChunks: vi.fn().mockReturnValue([
				{ type: "tool_call_end", id: "multi-1" },
				{ type: "tool_call_end", id: "multi-2" },
			]),
			finalizeStreamingToolCall: vi.fn().mockReturnValueOnce(toolUse1).mockReturnValueOnce(toolUse2),
		}) as any
		const task = createMockTask()
		task.streamingToolCallIndices.set("multi-1", 0)
		task.streamingToolCallIndices.set("multi-2", 1)
		task.assistantMessageContent = [
			{ type: "tool_use", name: "read_file" as any, params: {}, partial: true } as ToolUse,
			{ type: "tool_use", name: "list_files" as any, params: {}, partial: true } as ToolUse,
		]

		const finalizeToolUse = vi.fn((_, __, ftu) => ftu)

		await finalizePendingStreamingToolCalls({
			task,
			toolCallParser,
			finalizeToolUse,
		})

		expect(finalizeToolUse).toHaveBeenCalledTimes(2)
	})

	it("ignores non-tool_call_end events from finalizeRawChunks", async () => {
		const toolCallParser = createMockToolCallParser({
			finalizeRawChunks: vi.fn().mockReturnValue([
				{ type: "tool_call_start", id: "x", name: "foo" },
				{ type: "tool_call_delta", id: "x", delta: "bar" },
			]),
		}) as any
		const task = createMockTask()
		const finalizeToolUse = vi.fn()

		await finalizePendingStreamingToolCalls({
			task,
			toolCallParser,
			finalizeToolUse,
		})

		expect(finalizeToolUse).not.toHaveBeenCalled()
	})

	it("handles empty finalize events", async () => {
		const toolCallParser = createMockToolCallParser({
			finalizeRawChunks: vi.fn().mockReturnValue([]),
		}) as any
		const task = createMockTask()
		const finalizeToolUse = vi.fn()

		await finalizePendingStreamingToolCalls({
			task,
			toolCallParser,
			finalizeToolUse,
		})

		expect(finalizeToolUse).not.toHaveBeenCalled()
		expect(task.presentAssistantMessage).not.toHaveBeenCalled()
	})
})
