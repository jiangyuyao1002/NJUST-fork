// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage.loop.spec.ts

import { describe, it, expect, vi } from "vitest"
import { presentAssistantMessage, markUserContentReadyIfDrained } from "../presentAssistantMessage"

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => false),
}))
vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
		},
	},
}))

function makeMockTask(overrides: Record<string, unknown> = {}) {
	const task: any = {
		taskId: "loop-test",
		instanceId: "inst-1",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [],
		userMessageContent: [],
		didCompleteReadingStream: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		clineMessages: [],
		userMessageContentReady: false,
		api: { getModel: () => ({ id: "test", info: {} }) },
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: { check: vi.fn().mockReturnValue({ allowExecution: true }) },
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn().mockImplementation(function (this: any, tr: any) {
			task.userMessageContent.push(tr)
			return true
		}),
		...overrides,
	}
	return task
}

describe("presentAssistantMessage �?dispatch loop", () => {
	it("processes multiple consecutive text blocks in a single call without recursion", async () => {
		const task = makeMockTask({
			assistantMessageContent: [
				{ type: "text", content: "Hello", partial: false },
				{ type: "text", content: "World", partial: false },
			],
			didCompleteReadingStream: true,
		})

		await presentAssistantMessage(task)

		expect(task.say).toHaveBeenCalledTimes(2)
		expect(task.currentStreamingContentIndex).toBe(2)
		expect(task.userMessageContentReady).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("stops at partial block and does not advance further", async () => {
		const task = makeMockTask({
			assistantMessageContent: [
				{ type: "text", content: "Done", partial: false },
				{ type: "text", content: "Still coming...", partial: true },
			],
			didCompleteReadingStream: false,
		})

		await presentAssistantMessage(task)

		// First block processed, second is partial �?loop stops
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.userMessageContentReady).toBe(false)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("handles out-of-bounds with didCompleteReadingStream", async () => {
		const task = makeMockTask({
			currentStreamingContentIndex: 5,
			assistantMessageContent: [{ type: "text", content: "a", partial: false }],
			didCompleteReadingStream: true,
		})

		await presentAssistantMessage(task)

		expect(task.userMessageContentReady).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("skips execution when didRejectTool is set but still advances index", async () => {
		const task = makeMockTask({
			didRejectTool: true,
			assistantMessageContent: [
				{ type: "text", content: "skipped", partial: false },
				{ type: "text", content: "also skipped", partial: false },
			],
			didCompleteReadingStream: true,
		})

		await presentAssistantMessage(task)

		// Text blocks with didRejectTool=true are skipped (break in switch)
		// but block advancement still happens
		expect(task.currentStreamingContentIndex).toBe(2)
		expect(task.userMessageContentReady).toBe(true)
	})

	it("returns immediately when locked, setting hasPendingUpdates", async () => {
		const task = makeMockTask({
			presentAssistantMessageLocked: true,
		})

		await presentAssistantMessage(task)

		expect(task.presentAssistantMessageHasPendingUpdates).toBe(true)
	})

	it("uses markUserContentReadyIfDrained correctly", () => {
		const task = makeMockTask({
			didCompleteReadingStream: true,
			currentStreamingContentIndex: 2,
			assistantMessageContent: [{ type: "text" }, { type: "text" }],
		})

		markUserContentReadyIfDrained(task)
		expect(task.userMessageContentReady).toBe(true)
	})
})
