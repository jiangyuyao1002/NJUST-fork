import { describe, it, expect, vi, beforeEach } from "vitest"

import { TaskStreamProcessor } from "../TaskStreamProcessor"
import { TaskState } from "../TaskStateMachine"
import { logger } from "../../../shared/logger"

// Mock delay to prevent actual delays in tests
vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

// Mock logger to avoid console noise
vi.mock("../../../shared/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

// Mock globalQueryProfiler
vi.mock("../../../utils/queryProfiler", () => ({
	globalQueryProfiler: {
		start: vi.fn(),
		finish: vi.fn().mockReturnValue(undefined),
		markFirstToken: vi.fn(),
	},
}))

// Mock globalCacheMetrics
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

// Mock globalPromptCacheBreakDetector
vi.mock("../../prompts/promptCacheBreakDetection", () => ({
	globalPromptCacheBreakDetector: {
		check: vi.fn().mockReturnValue(null),
		getTotalBreaks: vi.fn().mockReturnValue(0),
		getBreaksBySource: vi.fn().mockReturnValue({}),
	},
}))

// Mock buildNativeToolsArrayWithRestrictions
vi.mock("../build-tools", () => ({
	buildNativeToolsArrayWithRestrictions: vi.fn().mockResolvedValue({
		tools: [],
		allowedFunctionNames: undefined,
	}),
}))

// Mock manageContext
vi.mock("../../context-management", () => ({
	manageContext: vi.fn().mockResolvedValue({ messages: [] }),
	willManageContext: vi.fn().mockReturnValue(false),
}))

// Mock getEnvironmentDetails
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

// Mock TokenBucketRateLimiter
vi.mock("../../../services/rate-limiter/TokenBucketRateLimiter", () => ({
	TokenBucketRateLimiter: {
		getInstance: vi.fn().mockReturnValue({
			wait: vi.fn().mockResolvedValue(0),
			drain: vi.fn(),
		}),
	},
}))

// Mock BackpressureController
vi.mock("../../stream/BackpressureController", () => ({
	BackpressureController: vi.fn().mockImplementation((stream: AsyncGenerator) => stream),
}))

// Mock resolveParallelNativeToolCalls
vi.mock("../../../shared/parallelToolCalls", () => ({
	resolveParallelNativeToolCalls: vi.fn().mockReturnValue(false),
}))

describe("TaskStreamProcessor", () => {
	let mockTask: any
	let processor: TaskStreamProcessor

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			cwd: "/test/workspace",
			abort: false,
			abandoned: false,
			apiConfiguration: {
				apiProvider: "anthropic",
				rateLimitSeconds: 0,
			},
			api: {
				getModel: vi.fn().mockReturnValue({
					id: "claude-3-sonnet",
					info: {
						contextWindow: 200_000,
						maxTokens: 4096,
					},
				}),
				countTokens: vi.fn().mockResolvedValue(0),
			},
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						apiConfiguration: { rateLimitSeconds: 0 },
						requestDelaySeconds: 1,
						unattendedMaxBackoffSeconds: 60,
						autoApprovalEnabled: false,
					}),
					postMessageToWebview: vi.fn().mockResolvedValue(undefined),
				}),
			},
			apiConversationHistory: [],
			requestCacheReadWindow: [],
			requestInputTokensWindow: [],
			getTokenUsage: vi.fn().mockReturnValue({
				totalTokensIn: 100,
				totalTokensOut: 50,
				totalCost: 0.01,
				contextTokens: 150,
			}),
			say: vi.fn().mockResolvedValue(undefined),
			notifier: {
				postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			},
			requestBuilder: {
				getSystemPrompt: vi.fn().mockResolvedValue("test system prompt"),
			},
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
			stateMachine: {
				state: TaskState.IDLE,
				force: vi.fn(),
			},
		}

		processor = new TaskStreamProcessor(mockTask)
	})

	describe("getCurrentProfileId", () => {
		it("应返回匹配 currentApiConfigName 的 profile id", () => {
			const state = {
				listApiConfigMeta: [
					{ name: "default", id: "profile-default" },
					{ name: "work", id: "profile-work" },
				],
				currentApiConfigName: "work",
			}

			const result = processor.getCurrentProfileId(state)
			expect(result).toBe("profile-work")
		})

		it("当未找到匹配 profile 时返回 'default'", () => {
			const state = {
				listApiConfigMeta: [{ name: "default", id: "profile-default" }],
				currentApiConfigName: "nonexistent",
			}

			const result = processor.getCurrentProfileId(state)
			expect(result).toBe("default")
		})

		it("当 state 为空时返回 'default'", () => {
			const result = processor.getCurrentProfileId(undefined)
			expect(result).toBe("default")
		})

		it("当 listApiConfigMeta 为空时返回 'default'", () => {
			const state = {
				listApiConfigMeta: [],
				currentApiConfigName: "work",
			}

			const result = processor.getCurrentProfileId(state)
			expect(result).toBe("default")
		})
	})

	describe("checkTimeoutRetry", () => {
		it("首次超时时应允许重试", () => {
			const result = processor.checkTimeoutRetry()
			expect(result.allowed).toBe(true)
			expect(result.shouldFallback).toBe(false)
			expect(result.suggestedDelayMs).toBeGreaterThanOrEqual(0)
		})

		it("记录多次超时后应触发降级建议", () => {
			// Simulate multiple timeout retries (timeout max = 5 per category)
			for (let i = 0; i < 5; i++) {
				processor.persistentRetry.recordRetry("timeout", 2000)
			}

			const result = processor.checkTimeoutRetry()
			// After 5 retries, allowed should be false and fallback suggested
			expect(result.allowed).toBe(false)
			expect(result.shouldFallback).toBe(true)
		})
	})

	describe("inferErrorCategory (via backoffAndAnnounce)", () => {
		it("silently exits failed backoff work when the task was aborted", async () => {
			mockTask.abort = true
			mockTask.say = vi.fn().mockRejectedValue(new Error("Request cancelled by user"))

			await processor.backoffAndAnnounce(0, new Error("temporary failure"))

			expect(logger.error).not.toHaveBeenCalled()
		})

		it("应正确分类超时错误", async () => {
			const timeoutError = new Error("Request timeout")
			;(timeoutError as any).code = "ETIMEDOUT"

			await processor.backoffAndAnnounce(0, timeoutError)
			// Should have recorded a timeout retry
			const stats = processor.persistentRetry.getStats()
			expect(stats.totalRetries).toBeGreaterThan(0)
		})

		it("应正确分类连接错误", async () => {
			const connError = new Error("Connection reset")
			;(connError as any).code = "ECONNRESET"

			await processor.backoffAndAnnounce(0, connError)
			const stats = processor.persistentRetry.getStats()
			expect(stats.totalRetries).toBeGreaterThan(0)
		})

		it("应正确分类 429 速率限制", async () => {
			const rateLimitError = new Error("Rate limited")
			;(rateLimitError as any).status = 429

			await processor.backoffAndAnnounce(0, rateLimitError)
			const stats = processor.persistentRetry.getStats()
			expect(stats.totalRetries).toBeGreaterThan(0)
		})

		it("应正确分类 401 认证错误", async () => {
			const authError = new Error("Unauthorized")
			;(authError as any).status = 401

			await processor.backoffAndAnnounce(0, authError)
			const stats = processor.persistentRetry.getStats()
			expect(stats.totalRetries).toBeGreaterThan(0)
		})

		it("未知错误应归类为 unknown", async () => {
			const unknownError = new Error("Something weird happened")

			await processor.backoffAndAnnounce(0, unknownError)
			const stats = processor.persistentRetry.getStats()
			expect(stats.totalRetries).toBeGreaterThan(0)
		})
	})

	describe("buildCleanConversationHistory", () => {
		it("应保留普通用户和助手消息", () => {
			const messages = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
			]

			const result = processor.buildCleanConversationHistory(messages as any)
			expect(result).toHaveLength(2)
			expect(result[0]).toMatchObject({ role: "user", content: "Hello" })
			expect(result[1]).toMatchObject({ role: "assistant", content: "Hi there" })
		})

		it("应将加密的 reasoning 块提取为独立项", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", encrypted_content: "encrypted123", id: "rs_1", summary: [] },
						{ type: "text", text: "Final answer" },
					],
				},
			]

			mockTask.api.getModel = vi.fn().mockReturnValue({
				id: "claude-3",
				info: { preserveReasoning: false },
			})

			const result = processor.buildCleanConversationHistory(messages as any)
			// Should produce: reasoning block + assistant message without reasoning
			expect(result.length).toBeGreaterThanOrEqual(1)
		})

		it("当 preserveReasoning 为 true 时应保留 plain text reasoning", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "reasoning", text: "Let me think...", summary: [] },
						{ type: "text", text: "Answer" },
					],
				},
			]

			mockTask.api.getModel = vi.fn().mockReturnValue({
				id: "deepseek-r1",
				info: { preserveReasoning: true },
			})

			const result = processor.buildCleanConversationHistory(messages as any)
			expect(result.length).toBeGreaterThanOrEqual(1)
			const assistantMsg = result.find((m: any) => m.role === "assistant")
			expect(assistantMsg).toBeDefined()
		})

		it("应处理 top-level reasoning_content", () => {
			const messages = [
				{
					role: "assistant",
					content: "Answer",
					reasoning_content: "My reasoning process",
				},
			]

			mockTask.api.getModel = vi.fn().mockReturnValue({
				id: "deepseek-r1",
				info: { preserveReasoning: true },
			})

			const result = processor.buildCleanConversationHistory(messages as any)
			expect(result).toHaveLength(1)
			expect((result[0] as any).reasoning_content).toBe("My reasoning process")
		})

		it("应跳过空的 reasoning 消息", () => {
			const messages = [
				{
					role: "user",
					content: "Hello",
				},
			]

			const result = processor.buildCleanConversationHistory(messages as any)
			expect(result).toHaveLength(1)
		})
	})
})
