import { ChatStateSync } from "../ChatStateSync"
import { EventEmitter } from "events"
import { NJUST_AIEventName } from "@njust-ai/types"
import { logger } from "../../shared/logger"
import { renderClineMessage } from "../message-renderer"

vi.mock("../../shared/logger")
vi.mock("../message-renderer")

describe("ChatStateSync", () => {
	let sync: ChatStateSync
	let provider: any
	let outputChannel: any

	beforeEach(() => {
		vi.useFakeTimers()
		provider = {
			getCurrentTask: vi.fn(),
		}
		outputChannel = { appendLine: vi.fn() }
		sync = new ChatStateSync(provider as any, outputChannel as any)
	})

	afterEach(() => {
		sync.dispose()
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("should retry up to 5 times with exponential backoff if task is not ready", () => {
		sync.registerChatTask("task-1", {} as any)

		expect(provider.getCurrentTask).toHaveBeenCalledTimes(1)

		// Initial call failed. Retry 1 (delay 200ms)
		vi.advanceTimersByTime(200)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(2)

		// Retry 2 (delay 400ms)
		vi.advanceTimersByTime(400)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(3)

		// Retry 3 (delay 800ms)
		vi.advanceTimersByTime(800)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(4)

		// Retry 4 (delay 1600ms)
		vi.advanceTimersByTime(1600)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(5)

		// Retry 5 (delay 3200ms)
		vi.advanceTimersByTime(3200)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(6)

		// After 5 retries, it should stop
		vi.advanceTimersByTime(6400)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(6)

		expect(logger.warn).toHaveBeenCalledWith(
			"ChatStateSync",
			expect.stringContaining("Failed to subscribe to task task-1 after 5 retries"),
		)
	})

	it("should subscribe successfully if task becomes ready during retries", () => {
		sync.registerChatTask("task-2", {} as any)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(1)

		const mockTask = new EventEmitter()
		;(mockTask as any).taskId = "task-2"

		// Task becomes ready before the first retry
		provider.getCurrentTask.mockReturnValue(mockTask)

		// Retry 1 (delay 200ms)
		vi.advanceTimersByTime(200)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(2)

		// Should have subscribed
		expect(mockTask.listenerCount(NJUST_AIEventName.Message)).toBe(1)

		// Further timers shouldn't cause more retries
		vi.advanceTimersByTime(1000)
		expect(provider.getCurrentTask).toHaveBeenCalledTimes(2)
	})

	it("should clean up event listeners when task completes", () => {
		const mockTask = new EventEmitter()
		;(mockTask as any).taskId = "task-3"
		provider.getCurrentTask.mockReturnValue(mockTask)

		sync.registerChatTask("task-3", {} as any)
		expect(mockTask.listenerCount(NJUST_AIEventName.Message)).toBe(1)

		mockTask.emit(NJUST_AIEventName.TaskCompleted)

		expect(mockTask.listenerCount(NJUST_AIEventName.Message)).toBe(0)
	})

	it("should sync messages to chat stream", () => {
		const mockTask = new EventEmitter()
		;(mockTask as any).taskId = "task-4"
		provider.getCurrentTask.mockReturnValue(mockTask)

		const mockStream = { progress: vi.fn(), markdown: vi.fn() } as any
		sync.registerChatTask("task-4", mockStream)

		const message = { type: "say", text: "hello" }
		mockTask.emit(NJUST_AIEventName.Message, { action: "created", message })

		expect(renderClineMessage).toHaveBeenCalledWith(mockStream, message)
	})

	it("should ignore messages with action 'updated'", () => {
		const mockTask = new EventEmitter()
		;(mockTask as any).taskId = "task-5"
		provider.getCurrentTask.mockReturnValue(mockTask)

		const mockStream = { progress: vi.fn(), markdown: vi.fn() } as any
		sync.registerChatTask("task-5", mockStream)

		mockTask.emit(NJUST_AIEventName.Message, {
			action: "updated",
			message: { type: "say", text: "updated message" },
		})

		expect(renderClineMessage).not.toHaveBeenCalled()
	})
})
