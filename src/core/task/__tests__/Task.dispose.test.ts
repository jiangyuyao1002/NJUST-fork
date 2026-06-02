import { describe, test, expect, vi, beforeEach, afterEach } from "vitest"

import { ProviderSettings } from "@njust-ai/types"

import { Task } from "../Task"
import type { ITaskHost } from "../interfaces/ITaskHost"

// Mock dependencies
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(function () {
		return {
			getModel: () => ({ info: {}, id: "test-model" }),
		}
	}),
}))
vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task dispose method", () => {
	let mockProvider: any
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		}
		mockApiConfiguration = {
			apiProvider: "anthropic",
			apiKey: "test-key",
		} as ProviderSettings
		task = new Task({
			provider: mockProvider as ITaskHost,
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
	})

	afterEach(() => {
		if (task && !task.abort) {
			task.dispose()
		}
	})

	test("marks isDisposed and removes listeners", () => {
		const listener1 = vi.fn(function () {})
		;(task as any).on("TaskStarted", listener1)
		expect(task.listenerCount("TaskStarted")).toBe(1)

		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")
		task.dispose()

		expect(task.isDisposed).toBe(true)
		expect(removeAllListenersSpy).toHaveBeenCalled()
		expect(task.listenerCount("TaskStarted")).toBe(0)
	})

	test("does not throw when removeAllListeners throws", () => {
		task.removeAllListeners = vi.fn(function () {
			throw new Error("Test error")
		})
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(function () {})
		expect(() => task.dispose()).not.toThrow()
		expect(consoleErrorSpy).toHaveBeenCalled()
		consoleErrorSpy.mockRestore()
	})

	test("sets isDisposed flag during dispose", () => {
		task.dispose()
		expect(task.isDisposed).toBe(true)
	})

	test("clears queued message timer through public dispose", () => {
		vi.useFakeTimers()
		const callback = vi.fn()
		const timer = setTimeout(callback, 1000)
		;(task as any).queuedMessageTimer = timer

		task.dispose()

		expect((task as any).queuedMessageTimer).toBeUndefined()
		vi.advanceTimersByTime(1000)
		expect(callback).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	test("removes all listeners during dispose", () => {
		const listeners = {
			TaskStarted: vi.fn(function () {}),
			TaskAborted: vi.fn(function () {}),
			TaskIdle: vi.fn(function (_taskId: string) {}),
			TaskActive: vi.fn(function (_taskId: string) {}),
			TaskAskResponded: vi.fn(function () {}),
			Message: vi.fn(function (_data: { action: "created" | "updated"; message: any }) {}),
			TaskTokenUsageUpdated: vi.fn(function (_taskId: string, _tokenUsage: any) {}),
			TaskToolFailed: vi.fn(function (_taskId: string, _tool: any, _error: string) {}),
			TaskUnpaused: vi.fn(function () {}),
		}
		const taskAny = task as any
		taskAny.on("TaskStarted", listeners.TaskStarted)
		taskAny.on("TaskAborted", listeners.TaskAborted)
		taskAny.on("TaskIdle", listeners.TaskIdle)
		taskAny.on("TaskActive", listeners.TaskActive)
		taskAny.on("TaskAskResponded", listeners.TaskAskResponded)
		taskAny.on("Message", listeners.Message)
		taskAny.on("TaskTokenUsageUpdated", listeners.TaskTokenUsageUpdated)
		taskAny.on("TaskToolFailed", listeners.TaskToolFailed)
		taskAny.on("TaskUnpaused", listeners.TaskUnpaused)

		expect(task.listenerCount("TaskStarted")).toBe(1)
		expect(task.listenerCount("TaskAborted")).toBe(1)
		expect(task.listenerCount("TaskIdle")).toBe(1)
		expect(task.listenerCount("TaskActive")).toBe(1)
		expect(task.listenerCount("TaskAskResponded")).toBe(1)
		expect(task.listenerCount("Message")).toBe(1)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(1)
		expect(task.listenerCount("TaskToolFailed")).toBe(1)
		expect(task.listenerCount("TaskUnpaused")).toBe(1)

		task.dispose()
		expect(task.isDisposed).toBe(true)
		expect(task.listenerCount("TaskStarted")).toBe(0)
		expect(task.listenerCount("TaskAborted")).toBe(0)
		expect(task.listenerCount("TaskIdle")).toBe(0)
		expect(task.listenerCount("TaskActive")).toBe(0)
		expect(task.listenerCount("TaskAskResponded")).toBe(0)
		expect(task.listenerCount("Message")).toBe(0)
		expect(task.listenerCount("TaskTokenUsageUpdated")).toBe(0)
		expect(task.listenerCount("TaskToolFailed")).toBe(0)
		expect(task.listenerCount("TaskUnpaused")).toBe(0)
	})
})
