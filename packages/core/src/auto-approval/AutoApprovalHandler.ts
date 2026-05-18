import { GlobalState, ClineMessage, ClineAsk } from "@njust-ai-cj/types"

import { ClineAskResponse } from "../shared/WebviewMessage.js"

export interface AutoApprovalResult {
	shouldProceed: boolean
	requiresApproval: boolean
	approvalType?: "requests" | "cost"
	approvalCount?: number | string
}

function addCostAndRequestsFromMessage(message: ClineMessage, into: { cost: number; requests: number }): void {
	if (message.type === "say" && message.say === "api_req_started" && message.text) {
		into.requests += 1
		try {
			const parsed: { cost?: number } = JSON.parse(message.text)
			if (typeof parsed.cost === "number") {
				into.cost += parsed.cost
			}
		} catch {
			// ignore
		}
	} else if (message.type === "say" && message.say === "condense_context") {
		into.cost += message.contextCondense?.cost ?? 0
	}
}

export class AutoApprovalHandler {
	private lastResetMessageIndex: number = 0
	private consecutiveAutoApprovedRequestsCount: number = 0
	private consecutiveAutoApprovedCost: number = 0
	/**
	 * Next array index to fold into `consecutive*`. After each sync,
	 * `nextUnprocessedIndex === messages.length`. A shrinking message array
	 * triggers a full re-scan of the current window to stay consistent.
	 */
	private nextUnprocessedIndex: number = 0

	/**
	 * Rebuilds request/cost totals for indices `[lastResetMessageIndex, messages.length)`.
	 */
	private rebuildWindowFromMessages(messages: ClineMessage[]): void {
		this.consecutiveAutoApprovedRequestsCount = 0
		this.consecutiveAutoApprovedCost = 0
		for (let i = this.lastResetMessageIndex; i < messages.length; i++) {
			const m = messages[i]
			if (!m) continue
			const acc = { cost: 0, requests: 0 }
			addCostAndRequestsFromMessage(m, acc)
			this.consecutiveAutoApprovedCost += acc.cost
			this.consecutiveAutoApprovedRequestsCount += acc.requests
		}
		this.nextUnprocessedIndex = messages.length
	}

	/**
	 * O(delta) for newly appended messages; falls back to full window rebuild if history shrank.
	 */
	private syncFromMessagesIfNeeded(messages: ClineMessage[]): void {
		if (this.nextUnprocessedIndex < this.lastResetMessageIndex) {
			this.rebuildWindowFromMessages(messages)
			return
		}
		if (messages.length < this.nextUnprocessedIndex) {
			this.rebuildWindowFromMessages(messages)
			return
		}
		const n = messages.length
		for (let i = this.nextUnprocessedIndex; i < n; i++) {
			if (i < this.lastResetMessageIndex) continue
			const m = messages[i]
			if (!m) continue
			const acc = { cost: 0, requests: 0 }
			addCostAndRequestsFromMessage(m, acc)
			this.consecutiveAutoApprovedCost += acc.cost
			this.consecutiveAutoApprovedRequestsCount += acc.requests
		}
		this.nextUnprocessedIndex = n
	}

	private onApprovalResetToEndOfMessages(messages: ClineMessage[]): void {
		this.lastResetMessageIndex = messages.length
		this.consecutiveAutoApprovedRequestsCount = 0
		this.consecutiveAutoApprovedCost = 0
		this.nextUnprocessedIndex = messages.length
	}

	/**
	 * Check if auto-approval limits have been reached and handle user approval if needed
	 */
	async checkAutoApprovalLimits(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
	): Promise<AutoApprovalResult> {
		this.syncFromMessagesIfNeeded(messages)

		// Check request count limit
		const requestResult = await this.checkRequestLimit(state, messages, askForApproval)
		if (!requestResult.shouldProceed || requestResult.requiresApproval) {
			return requestResult
		}

		// Check cost limit
		const costResult = await this.checkCostLimit(state, messages, askForApproval)
		return costResult
	}

	/**
	 * Calculate request count and check if limit is exceeded
	 */
	private async checkRequestLimit(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
	): Promise<AutoApprovalResult> {
		const maxRequests = state?.allowedMaxRequests || Infinity

		// +1 = the API call about to be made (not yet in `messages`)
		if (this.consecutiveAutoApprovedRequestsCount + 1 > maxRequests) {
			const { response } = await askForApproval(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: maxRequests, type: "requests" }),
			)

			// If we get past the promise, it means the user approved and did not start a new task
			if (response === "yesButtonClicked") {
				this.onApprovalResetToEndOfMessages(messages)
				return {
					shouldProceed: true,
					requiresApproval: true,
					approvalType: "requests",
					approvalCount: maxRequests,
				}
			}

			return {
				shouldProceed: false,
				requiresApproval: true,
				approvalType: "requests",
				approvalCount: maxRequests,
			}
		}

		return { shouldProceed: true, requiresApproval: false }
	}

	/**
	 * Calculate current cost and check if limit is exceeded
	 */
	private async checkCostLimit(
		state: GlobalState | undefined,
		messages: ClineMessage[],
		askForApproval: (
			type: ClineAsk,
			data: string,
		) => Promise<{ response: ClineAskResponse; text?: string; images?: string[] }>,
	): Promise<AutoApprovalResult> {
		const maxCost = state?.allowedMaxCost || Infinity

		// Use epsilon for floating-point comparison to avoid precision issues
		const EPSILON = 0.0001
		if (this.consecutiveAutoApprovedCost > maxCost + EPSILON) {
			const { response } = await askForApproval(
				"auto_approval_max_req_reached",
				JSON.stringify({ count: maxCost.toFixed(2), type: "cost" }),
			)

			// If we get past the promise, it means the user approved and did not start a new task
			if (response === "yesButtonClicked") {
				this.onApprovalResetToEndOfMessages(messages)
				return {
					shouldProceed: true,
					requiresApproval: true,
					approvalType: "cost",
					approvalCount: maxCost.toFixed(2),
				}
			}

			return {
				shouldProceed: false,
				requiresApproval: true,
				approvalType: "cost",
				approvalCount: maxCost.toFixed(2),
			}
		}

		return { shouldProceed: true, requiresApproval: false }
	}

	/**
	 * Reset the tracking (typically called when starting a new task)
	 */
	resetRequestCount(): void {
		this.lastResetMessageIndex = 0
		this.consecutiveAutoApprovedRequestsCount = 0
		this.consecutiveAutoApprovedCost = 0
		this.nextUnprocessedIndex = 0
	}

	/**
	 * Get current approval state for debugging/testing
	 * `requestCount` includes the in-flight / about-to-be-sent API call (+1), matching
	 * the historical `filter(...).length + 1` display semantics.
	 */
	getApprovalState(): { requestCount: number; currentCost: number } {
		return {
			requestCount: this.consecutiveAutoApprovedRequestsCount + 1,
			currentCost: this.consecutiveAutoApprovedCost,
		}
	}
}
