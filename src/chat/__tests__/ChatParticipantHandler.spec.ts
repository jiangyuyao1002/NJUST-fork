import { EventEmitter } from "events"
import { ChatParticipantHandler } from "../ChatParticipantHandler"
import { TelemetryEventName, NJUST_AIEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import { renderClineMessage } from "../message-renderer"

vi.mock("@njust-ai/telemetry")
vi.mock("../message-renderer")
vi.mock("vscode", () => {
	const mockChatParticipant = {
		iconPath: undefined,
		followupProvider: undefined,
		onDidReceiveFeedback: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		dispose: vi.fn(),
	}
	const mockChat = {
		createChatParticipant: vi.fn().mockReturnValue(mockChatParticipant),
	}
	return {
		chat: mockChat,
		Uri: { joinPath: vi.fn() },
		CancellationTokenSource: class {
			token = { onCancellationRequested: vi.fn() }
		},
	}
})

describe("ChatParticipantHandler", () => {
	let provider: any
	let context: any
	let outputChannel: any
	let handler: ChatParticipantHandler

	beforeEach(() => {
		vi.useFakeTimers()
		provider = {
			handleModeSwitch: vi.fn(),
			createTask: vi.fn(),
		}
		context = {
			extensionUri: {},
			subscriptions: { push: vi.fn() },
		}
		outputChannel = { appendLine: vi.fn() }
		handler = new ChatParticipantHandler(provider as any, context, outputChannel)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("should cleanup listeners and resolve when task completes", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-1"
		;(task as any).abortTask = vi.fn()

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		// simulate handleRequest call to start streaming
		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		// Wait for promise microtasks so task event listeners are attached
		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		task.emit(NJUST_AIEventName.TaskCompleted)

		await handleRequestPromise

		expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(0)
		expect(task.listenerCount(NJUST_AIEventName.TaskCompleted)).toBe(0)
		expect(task.listenerCount(NJUST_AIEventName.TaskAborted)).toBe(0)
	})

	it("should cleanup when aborted", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-2"
		;(task as any).abortTask = vi.fn()

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		task.emit(NJUST_AIEventName.TaskAborted)

		await handleRequestPromise

		expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(0)
	})

	it("should report TASK_LIFECYCLE_ERROR if rendering fails", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-3"
		;(task as any).abortTask = vi.fn()

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		// Render throws error
		vi.mocked(renderClineMessage).mockImplementationOnce(() => {
			throw new Error("Render failed")
		})

		task.emit(NJUST_AIEventName.Message, { action: "created", message: { text: "hi" } })

		expect(TelemetryService.reportError).toHaveBeenCalledWith(
			expect.any(Error),
			TelemetryEventName.TASK_LIFECYCLE_ERROR,
		)

		task.emit(NJUST_AIEventName.TaskCompleted)
		await handleRequestPromise
	})

	it("should cleanup via safety timer if task finishes without emitting event", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-4"
		;(task as any).abortTask = vi.fn()
		;(task as any).didFinishAbortingStream = false

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		// Simulate silent completion
		;(task as any).didFinishAbortingStream = true

		vi.advanceTimersByTime(3000)

		await handleRequestPromise

		expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(0)
	})

	it("should call abortTask on cancellation token", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-5"
		;(task as any).abortTask = vi.fn()

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		let cancelCb: () => void = () => {}
		const token = {
			onCancellationRequested: (cb: () => void) => {
				cancelCb = cb
			},
		} as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		cancelCb()

		await handleRequestPromise

		expect((task as any).abortTask).toHaveBeenCalled()
		expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(0)
	})

	it("should cleanup via 5min timeout", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-6"
		;(task as any).abortTask = vi.fn()

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		vi.advanceTimersByTime(5 * 60 * 1000)

		await handleRequestPromise

		expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(0)
	})

	it("should replay existing messages created before event subscription", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-race"
		;(task as any).abortTask = vi.fn()
		;(task as any).clineMessages = [
			{ id: "m1", type: "say", say: "text", text: "Already here", ts: 1 },
			{ id: "m2", type: "say", say: "text", text: "Also here", ts: 2 },
		]

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		expect(renderClineMessage).toHaveBeenCalledTimes(2)

		task.emit(NJUST_AIEventName.TaskCompleted)
		await handleRequestPromise
	})

	it("should not treat different messages with the same timestamp as duplicates", async () => {
		const task = new EventEmitter()
		;(task as any).taskId = "task-same-ts"
		;(task as any).abortTask = vi.fn()
		;(task as any).clineMessages = [
			{ id: "m1", type: "say", say: "text", text: "First", ts: 1 },
			{ id: "m2", type: "say", say: "text", text: "Second", ts: 1 },
		]

		provider.createTask.mockResolvedValue(task)

		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any

		const handleRequestPromise = (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)

		await vi.waitFor(() => expect(task.listenerCount(NJUST_AIEventName.Message)).toBe(1))

		expect(renderClineMessage).toHaveBeenCalledTimes(2)

		task.emit(NJUST_AIEventName.TaskCompleted)
		await handleRequestPromise
	})

	it("should report EXTENSION_INIT_ERROR when createTask throws", async () => {
		provider.createTask.mockRejectedValue(new Error("createTask failed"))
		const stream = { progress: vi.fn(), markdown: vi.fn() } as any
		const token = { onCancellationRequested: vi.fn() } as any
		const result = await (handler as any).handleRequest(
			{ command: "code", prompt: "hello" },
			{ history: [] },
			stream,
			token,
		)
		expect(TelemetryService.reportError).toHaveBeenCalledWith(
			expect.any(Error),
			TelemetryEventName.EXTENSION_INIT_ERROR,
		)
		expect(result.metadata.command).toBe("code")
	})

	it("should provide followups for architect command", () => {
		const result = (handler as any).provideFollowups({ metadata: { command: "architect" } }, {}, {})
		expect(result).toHaveLength(1)
		expect(result[0].command).toBe("code")
	})

	it("should provide followups for code command", () => {
		const result = (handler as any).provideFollowups({ metadata: { command: "code" } }, {}, {})
		expect(result).toHaveLength(2)
		expect(result.map((f: any) => f.command)).toEqual(["ask", "debug"])
	})
})
