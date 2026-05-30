import { describe, it, expect, vi, beforeEach } from "vitest"

import { GlobalState, ClineMessage } from "@njust-ai/types"

import { getApiMetrics } from "../../shared/getApiMetrics.js"
import { AutoApprovalHandler } from "../AutoApprovalHandler.js"

describe("AutoApprovalHandler", () => {
	let handler: AutoApprovalHandler
	let mockAskForApproval: ReturnType<typeof vi.fn>
	let mockState: GlobalState

	beforeEach(() => {
		handler = new AutoApprovalHandler()
		mockAskForApproval = vi.fn()
		mockState = {} as GlobalState
		vi.clearAllMocks()
	})

	describe("checkAutoApprovalLimits", () => {
		it("should proceed when no limits are set", async () => {
			const messages: ClineMessage[] = []
			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(false)
			expect(mockAskForApproval).not.toHaveBeenCalled()
		})

		it("should check request limit before cost limit", async () => {
			mockState.allowedMaxRequests = 1
			mockState.allowedMaxCost = 10
			const messages: ClineMessage[] = []

			// First call should be under limit (count = 1)
			const result1 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result1.shouldProceed).toBe(true)
			expect(result1.requiresApproval).toBe(false)

			// Add a message to simulate first request completed
			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 1000 })

			// Second call should trigger request limit (1 message + current = 2 > 1)
			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })
			const result2 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(mockAskForApproval).toHaveBeenCalledWith(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: 1, type: "requests" }),
			)
			expect(result2.shouldProceed).toBe(true)
			expect(result2.requiresApproval).toBe(true)
			expect(result2.approvalType).toBe("requests")
		})
	})

	describe("request limit handling", () => {
		beforeEach(() => {
			mockState.allowedMaxRequests = 3
		})

		it("should calculate request count from messages", async () => {
			const messages: ClineMessage[] = []

			// First check - no messages yet, count should be 1 (for current request)
			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			let state = handler.getApprovalState()
			expect(state.requestCount).toBe(1)

			// Add API request messages
			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 1000 })
			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			state = handler.getApprovalState()
			expect(state.requestCount).toBe(2) // 1 message + current request

			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 2000 })
			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			state = handler.getApprovalState()
			expect(state.requestCount).toBe(3) // 2 messages + current request
		})

		it("should ask for approval when limit is exceeded", async () => {
			const messages: ClineMessage[] = []

			// Add 3 API request messages (to simulate 3 requests made)
			for (let i = 0; i < 3; i++) {
				messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 1000 + i })
			}

			// Next check should trigger approval (3 messages + current = 4 > 3)
			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })
			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(mockAskForApproval).toHaveBeenCalledWith(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: 3, type: "requests" }),
			)
			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(true)
		})

		it("should reset count when user approves", async () => {
			const messages: ClineMessage[] = []

			// Add messages to exceed limit
			for (let i = 0; i < 3; i++) {
				messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 1000 + i })
			}

			// Next request should trigger approval and reset
			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })
			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			// Add more messages after reset
			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 4000 })

			// Next check should only count messages after reset
			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result.requiresApproval).toBe(false) // Should not require approval (1 message + current = 2 <= 3)

			const state = handler.getApprovalState()
			expect(state.requestCount).toBe(2) // 1 message after reset + current request
		})

		it("should not proceed when user rejects", async () => {
			const messages: ClineMessage[] = []

			// Add messages to exceed limit
			for (let i = 0; i < 3; i++) {
				messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 1000 + i })
			}

			// Next request with rejection
			mockAskForApproval.mockResolvedValue({ response: "noButtonClicked" })
			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(result.shouldProceed).toBe(false)
			expect(result.requiresApproval).toBe(true)
		})
	})

	describe("cost limit handling", () => {
		beforeEach(() => {
			mockState.allowedMaxCost = 5.0
		})

		it("should calculate cost from messages", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 2.0 }), ts: 1000 },
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 1.5 }), ts: 2000 },
			]

			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(false)
			expect(handler.getApprovalState().currentCost).toBeCloseTo(3.5, 5)
		})

		it("should ask for approval when cost limit is exceeded", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 5.5 }), ts: 1000 },
			]

			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })

			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(mockAskForApproval).toHaveBeenCalledWith(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: "5.00", type: "cost" }),
			)
			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(true)
			expect(result.approvalType).toBe("cost")
		})

		it("should not trigger at exactly max cost (within epsilon)", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 5.0 }), ts: 1000 },
			]
			const result1 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result1.requiresApproval).toBe(false)
		})

		it("should not trigger just below max + epsilon from floating noise", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 5.00009 }), ts: 1000 },
			]
			const result2 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result2.requiresApproval).toBe(false)
		})

		it("should trigger when cost exceeds max beyond epsilon", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 5.001 }), ts: 1000 },
			]
			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })
			const result3 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result3.requiresApproval).toBe(true)
		})

		it("should reset cost tracking on approval", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 3.0}', ts: 1000 },
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 3.0}', ts: 2000 },
			]

			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })

			const result1 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result1.shouldProceed).toBe(true)
			expect(result1.requiresApproval).toBe(true)

			messages.push(
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 2.0}', ts: 3000 },
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 1.0}', ts: 4000 },
			)

			const result2 = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(result2.shouldProceed).toBe(true)
			expect(result2.requiresApproval).toBe(false)

			const sliceAfterReset = messages.slice(2)
			const fromGetApi = getApiMetrics(sliceAfterReset).totalCost
			expect(handler.getApprovalState().currentCost).toBeCloseTo(fromGetApi, 5)
		})

		it("should track multiple cost resets correctly", async () => {
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 6.0}', ts: 1000 },
			]

			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			messages.push(
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 3.0}', ts: 2000 },
				{ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 3.0}', ts: 3000 },
			)

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: '{"cost": 2.0}', ts: 4000 })

			const result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(result.requiresApproval).toBe(false)
			expect(handler.getApprovalState().currentCost).toBeCloseTo(
				getApiMetrics(messages.slice(3)).totalCost,
				5,
			)
		})
	})

	describe("combined limits", () => {
		it("should handle both request and cost limits", async () => {
			mockState.allowedMaxRequests = 2
			mockState.allowedMaxCost = 10.0
			const messages: ClineMessage[] = []

			mockAskForApproval.mockResolvedValue({ response: "yesButtonClicked" })

			// First request: 0 completed + 1 current = 1 <= 2
			let result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(false)

			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 1.0 }), ts: 1000 })
			// Second: 1 + 1 = 2 <= 2
			result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(false)

			messages.push({ type: "say", say: "api_req_started", id: "test-id", text: "{}", ts: 2000 })
			// Third: 2 + 1 = 3 > 2 → request limit
			result = await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			expect(mockAskForApproval).toHaveBeenCalledWith(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: 2, type: "requests" }),
			)
			expect(result.shouldProceed).toBe(true)
			expect(result.requiresApproval).toBe(true)
			expect(result.approvalType).toBe("requests")
		})
	})

	describe("resetRequestCount", () => {
		it("should reset tracking", async () => {
			mockState.allowedMaxRequests = 5
			mockState.allowedMaxCost = 10.0
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 2.0 }), ts: 1 },
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 1.0 }), ts: 2 },
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 2.0 }), ts: 3 },
			]

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			let state = handler.getApprovalState()
			expect(state.requestCount).toBe(4) // 3 messages + current
			expect(state.currentCost).toBe(5.0)

			handler.resetRequestCount()

			state = handler.getApprovalState()
			expect(state.requestCount).toBe(1)
			expect(state.currentCost).toBe(0)

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)

			state = handler.getApprovalState()
			expect(state.requestCount).toBe(4) // 3 + current
			expect(state.currentCost).toBe(5.0)
		})
	})

	describe("incremental O(1) re-checks", () => {
		it("does not re-scan the full message array when length is unchanged", async () => {
			mockState.allowedMaxCost = 100
			const messages: ClineMessage[] = [
				{ type: "say", say: "api_req_started", id: "test-id", text: JSON.stringify({ cost: 0.1 }), ts: 1 },
			]
			const spy = vi.spyOn(Array.prototype, "forEach")

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			const callsAfterFirst = spy.mock.calls.length

			await handler.checkAutoApprovalLimits(mockState, messages, mockAskForApproval)
			const callsAfterSecond = spy.mock.calls.length

			// New behaviour should not re-iterate the whole array via getApiMetrics / slice+filter
			expect(callsAfterSecond - callsAfterFirst).toBe(0)
			spy.mockRestore()
		})
	})
})
