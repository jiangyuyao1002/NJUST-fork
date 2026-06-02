import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ErrorRecoveryHandler } from "../ErrorRecoveryHandler"

vi.mock("../../errors/apiErrorClassifier", () => ({
	classifyApiError: vi.fn(),
}))

vi.mock("../../errors/retryPersistence", () => ({
	appendRetryEvent: vi.fn(async function () {}),
}))

vi.mock("../../context-management/reactiveCompact", () => ({
	reactiveCompactMessages: vi.fn(),
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}))

import { classifyApiError } from "../../errors/apiErrorClassifier"

function createMockTask(overrides: Record<string, unknown> = {}) {
	return {
		taskId: "task-1",
		globalStoragePath: "/tmp/storage",
		compactFailureCount: 0,
		maxCompactFailures: 3,
		apiConversationHistory: [],
		assistantMessageContent: [],
		forceTaskState: vi.fn(),
		handleContextWindowExceededError: vi.fn(async function () {}),
		addToApiConversationHistory: vi.fn(async function () {}),
		overwriteApiConversationHistory: vi.fn(async function () {}),
		getTokenUsage: vi.fn(function () {
			return {
				contextTokens: 50000,
			}
		}),
		tokenUsageSnapshot: null,
		tokenUsageSnapshotAt: 0,
		say: vi.fn(async function () {}),
		api: { getModel: () => ({ id: "test-model", info: { contextWindow: 200000 } }) },
		...overrides,
	} as any
}

describe("ErrorRecoveryHandler", () => {
	beforeEach(() => {
		vi.spyOn(ErrorRecoveryHandler.prototype as any, "delay").mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.clearAllMocks()
		vi.restoreAllMocks()
	})

	it("bypasses condense when compact failures exceed threshold", () => {
		const task = createMockTask({ compactFailureCount: 3, maxCompactFailures: 3 })
		const handler = new ErrorRecoveryHandler(task)
		expect(handler.shouldBypassCondense()).toBe(true)
	})

	it("does not bypass condense when failures below threshold", () => {
		const task = createMockTask({ compactFailureCount: 1, maxCompactFailures: 3 })
		const handler = new ErrorRecoveryHandler(task)
		expect(handler.shouldBypassCondense()).toBe(false)
	})

	it("records compact failure and increments counter", async () => {
		const task = createMockTask()
		const handler = new ErrorRecoveryHandler(task)
		await handler.recordCompactFailure("compact failed")
		expect(task.compactFailureCount).toBe(1)
		expect(task.say).toHaveBeenCalledWith("condense_context_error", "compact failed")
	})

	it("announces degradation when threshold reached", async () => {
		const task = createMockTask({ compactFailureCount: 2, maxCompactFailures: 3 })
		const handler = new ErrorRecoveryHandler(task)
		await handler.recordCompactFailure("fail")
		expect(task.compactFailureCount).toBe(3)
		expect(task.say).toHaveBeenCalledTimes(2)
	})

	it("resets compact failure counter after success", () => {
		const task = createMockTask({ compactFailureCount: 2 })
		const handler = new ErrorRecoveryHandler(task)
		handler.resetCompactFailure()
		expect(task.compactFailureCount).toBe(0)
	})

	describe("handleApiError", () => {
		async function handle(errorKind: string, retryAttempt = 0, taskOverrides: Record<string, unknown> = {}) {
			const task = createMockTask(taskOverrides)
			vi.mocked(classifyApiError).mockImplementation(() => errorKind as any)
			const handler = new ErrorRecoveryHandler(task)
			const result = await handler.handleApiError(new Error("test error"), retryAttempt)
			return { task, result }
		}

		it("stale_connection → immediate_retry", async () => {
			const { result } = await handle("stale_connection")
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("returns fallthrough without classifying when task is aborted", async () => {
			const task = createMockTask({ abort: true })
			const handler = new ErrorRecoveryHandler(task)

			const result = await handler.handleApiError(new Error("test error"), 0)

			expect(result).toEqual({ action: "fallthrough" })
			expect(classifyApiError).not.toHaveBeenCalled()
		})

		it("content_policy → fallthrough (never retries)", async () => {
			const { result, task } = await handle("content_policy")
			expect(result).toEqual({ action: "fallthrough" })
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("content safety policy"))
		})

		it("timeout at attempt 3 → model_fallback", async () => {
			const { result } = await handle("timeout", 3)
			expect(result.action).toBe("model_fallback")
			if (result.action === "model_fallback") {
				expect(result.reason).toContain("retries exhausted")
			}
		})

		it("timeout at attempt 0 → fallthrough (timeout_degrade)", async () => {
			const { result } = await handle("timeout", 0)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("invalid_tool_use → injects hint and retries", async () => {
			const { result, task } = await handle("invalid_tool_use", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
			expect(task.addToApiConversationHistory).toHaveBeenCalledWith(
				expect.objectContaining({ role: "user", content: expect.stringContaining("invalid format") }),
			)
		})

		it("invalid_tool_use at attempt 1 includes example", async () => {
			const { task } = await handle("invalid_tool_use", 1)
			expect(task.addToApiConversationHistory).toHaveBeenCalledWith(
				expect.objectContaining({ role: "user", content: expect.stringContaining("Example") }),
			)
		})

		it("invalid_tool_use at attempt 3 → fallthrough (none)", async () => {
			const { result } = await handle("invalid_tool_use", 3)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("context_window_exceeded → context_window_recover", async () => {
			const { result, task } = await handle("context_window_exceeded", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
			expect(task.forceTaskState).toHaveBeenCalled()
			expect(task.handleContextWindowExceededError).toHaveBeenCalled()
		})

		it("context_window_exceeded at attempt 2 → fallthrough (none)", async () => {
			const { result } = await handle("context_window_exceeded", 2)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("model_overloaded → overloaded_backoff then retry", async () => {
			const { result } = await handle("model_overloaded", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("model_overloaded at attempt 3 → model_fallback", async () => {
			const { result } = await handle("model_overloaded", 3)
			expect(result.action).toBe("model_fallback")
		})

		it("server_error → server_error_backoff then retry", async () => {
			const { result } = await handle("server_error", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("server_error at attempt 5 → fallthrough (none)", async () => {
			const { result } = await handle("server_error", 5)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("unknown → single retry", async () => {
			const { result } = await handle("unknown", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("unknown at attempt 1 → fallthrough (none)", async () => {
			const { result } = await handle("unknown", 1)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("rate_limit → fallthrough (backoff_retry is default case)", async () => {
			const { result } = await handle("rate_limit", 0)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("auth_error → fallthrough (none)", async () => {
			const { result } = await handle("auth_error", 0)
			expect(result).toEqual({ action: "fallthrough" })
		})

		it("partial_response → partial_continue then retry", async () => {
			const task = createMockTask()
			vi.mocked(classifyApiError).mockImplementation(() => "partial_response" as any)
			const handler = new ErrorRecoveryHandler(task)
			const result = await handler.handleApiError(new Error("test"), 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("media_too_large → strip_media_retry then retry", async () => {
			const { result } = await handle("media_too_large", 0)
			expect(result).toEqual({ action: "retry", nextAttempt: 1 })
		})

		it("media_too_large at attempt 2 → fallthrough (none)", async () => {
			const { result } = await handle("media_too_large", 2)
			expect(result).toEqual({ action: "fallthrough" })
		})
	})

	describe("shouldTriggerFallback", () => {
		it("returns false for non-eligible categories", () => {
			const handler = new ErrorRecoveryHandler(createMockTask())
			expect(handler.shouldTriggerFallback("rate_limit" as any, 5)).toBe(false)
		})

		it("returns true for timeout at fallback threshold", () => {
			const handler = new ErrorRecoveryHandler(createMockTask())
			expect(handler.shouldTriggerFallback("timeout" as any, 3)).toBe(true)
		})

		it("returns true for model_overloaded at fallback threshold", () => {
			const handler = new ErrorRecoveryHandler(createMockTask())
			expect(handler.shouldTriggerFallback("model_overloaded" as any, 3)).toBe(true)
		})

		it("returns false for timeout before threshold", () => {
			const handler = new ErrorRecoveryHandler(createMockTask())
			expect(handler.shouldTriggerFallback("timeout" as any, 0)).toBe(false)
		})
	})
})
