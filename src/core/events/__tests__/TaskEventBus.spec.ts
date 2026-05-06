import { describe, it, expect, vi } from "vitest"

// vscode.Disposable is used by TaskEventBus.on() return type
vi.mock("vscode", () => ({
	Disposable: class {
		private fn: () => void
		constructor(fn: () => void) { this.fn = fn }
		dispose() { this.fn() }
	},
}))

import { TaskEventBus, taskEventBus, enableTaskEventBusDebugLogging } from "../TaskEventBus"
import type { TaskEventName, TaskEventBusMiddleware } from "../TaskEventBus"

describe("TaskEventBus", () => {
	let bus: TaskEventBus

	beforeEach(() => {
		bus = new TaskEventBus()
	})

	it("delivers event to registered listener", () => {
		const listener = vi.fn()
		bus.on("task:started", listener)
		bus.emit("task:started", { taskId: "t1" })
		expect(listener).toHaveBeenCalledWith("task:started", { taskId: "t1" })
	})

	it("delivers to multiple listeners for same event", () => {
		const a = vi.fn()
		const b = vi.fn()
		bus.on("task:completed", a)
		bus.on("task:completed", b)
		bus.emit("task:completed", { taskId: "t1" })
		expect(a).toHaveBeenCalledOnce()
		expect(b).toHaveBeenCalledOnce()
	})

	it("does not deliver to unregistered event type", () => {
		const listener = vi.fn()
		bus.on("task:started", listener)
		bus.emit("task:completed", {})
		expect(listener).not.toHaveBeenCalled()
	})

	it("does not crash when emitting with no listeners", () => {
		expect(() => bus.emit("task:failed", {})).not.toThrow()
	})

	it("off() removes a specific listener", () => {
		const listener = vi.fn()
		bus.on("task:started", listener)
		bus.off("task:started", listener)
		bus.emit("task:started", {})
		expect(listener).not.toHaveBeenCalled()
	})

	it("on() returns a Disposable that removes the listener", () => {
		const listener = vi.fn()
		const disposable = bus.on("task:started", listener)
		disposable.dispose()
		bus.emit("task:started", {})
		expect(listener).not.toHaveBeenCalled()
	})

	it("isolates listener errors — one failing listener does not block others", () => {
		const bad = vi.fn(() => { throw new Error("boom") })
		const good = vi.fn()
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		bus.on("task:tool-completed", bad)
		bus.on("task:tool-completed", good)
		bus.emit("task:tool-completed", { taskId: "t1" })
		expect(good).toHaveBeenCalledOnce()
		expect(consoleSpy).toHaveBeenCalled()
		consoleSpy.mockRestore()
	})

	it("middleware wraps emit and can intercept", () => {
		const mw: TaskEventBusMiddleware = vi.fn((_event, _payload, next) => next())
		bus.setMiddleware(mw)
		const listener = vi.fn()
		bus.on("task:llm-response", listener)
		bus.emit("task:llm-response", {})
		expect(mw).toHaveBeenCalledOnce()
		expect(listener).toHaveBeenCalledOnce()
	})

	it("middleware can skip delivery", () => {
		const mw: TaskEventBusMiddleware = vi.fn()
		bus.setMiddleware(mw)
		const listener = vi.fn()
		bus.on("task:llm-retry", listener)
		bus.emit("task:llm-retry", {})
		expect(mw).toHaveBeenCalledOnce()
		expect(listener).not.toHaveBeenCalled()
	})

	it("setMiddleware(undefined) removes middleware", () => {
		const mw = vi.fn()
		bus.setMiddleware(mw)
		bus.setMiddleware(undefined)
		const listener = vi.fn()
		bus.on("task:started", listener)
		bus.emit("task:started", {})
		expect(mw).not.toHaveBeenCalled()
		expect(listener).toHaveBeenCalledOnce()
	})

	it("all 9 event types deliver correctly", () => {
		const events: TaskEventName[] = [
			"task:started", "task:completed", "task:failed", "task:aborted",
			"task:tool-executing", "task:tool-completed", "task:llm-response",
			"task:tokens-updated", "task:llm-retry",
		]
		for (const evt of events) {
			const listener = vi.fn()
			bus.on(evt, listener)
			bus.emit(evt, { taskId: "t1" })
			expect(listener).toHaveBeenCalledOnce()
		}
	})
})

describe("taskEventBus (global singleton)", () => {
	it("is a TaskEventBus instance", () => {
		expect(taskEventBus).toBeInstanceOf(TaskEventBus)
	})

	it("can receive and deliver events", () => {
		const listener = vi.fn()
		const disposable = taskEventBus.on("task:tokens-updated", listener)
		taskEventBus.emit("task:tokens-updated", { taskId: "g1" })
		expect(listener).toHaveBeenCalledWith("task:tokens-updated", { taskId: "g1" })
		disposable.dispose()
	})
})

vi.mock("../../../utils/debugLog", () => ({
	debugLog: (...args: unknown[]) => console.debug(...args),
}))

describe("enableTaskEventBusDebugLogging", () => {
	it("installs middleware on the global bus", () => {
		// Cleanup previous state
		taskEventBus.setMiddleware(undefined)

		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
		enableTaskEventBusDebugLogging()
		taskEventBus.emit("task:started", { taskId: "debug-test" })
		expect(debugSpy).toHaveBeenCalledWith("[TaskEventBus]", "task:started", { taskId: "debug-test" })
		debugSpy.mockRestore()
		taskEventBus.setMiddleware(undefined)
	})
})
