import { describe, it, expect, beforeEach, vi } from "vitest"
import { MessageQueueService } from "../MessageQueueService.js"

describe("MessageQueueService", () => {
	let queue: MessageQueueService

	beforeEach(() => {
		queue = new MessageQueueService()
	})

	it("starts empty", () => {
		expect(queue.isEmpty()).toBe(true)
		expect(queue.messages).toEqual([])
	})

	it("addMessage enqueues and emits stateChanged", () => {
		const spy = vi.fn()
		queue.on("stateChanged", spy)
		const msg = queue.addMessage("hello")
		expect(msg).toBeDefined()
		expect(msg!.text).toBe("hello")
		expect(queue.isEmpty()).toBe(false)
		expect(queue.messages).toHaveLength(1)
		expect(spy).toHaveBeenCalledTimes(1)
	})

	it("addMessage returns undefined for empty text and no images", () => {
		const msg = queue.addMessage("")
		expect(msg).toBeUndefined()
		expect(queue.isEmpty()).toBe(true)
	})

	it("addMessage accepts images array with empty text", () => {
		const msg = queue.addMessage("", ["data:image/png;base64,abc"])
		expect(msg).toBeDefined()
		expect(msg!.images).toHaveLength(1)
	})

	it("dequeueMessage removes and returns first message", () => {
		queue.addMessage("first")
		queue.addMessage("second")
		const dequeued = queue.dequeueMessage()
		expect(dequeued!.text).toBe("first")
		expect(queue.messages).toHaveLength(1)
		expect(queue.messages[0]!.text).toBe("second")
	})

	it("dequeueMessage returns undefined when empty", () => {
		expect(queue.dequeueMessage()).toBeUndefined()
	})

	it("removeMessage removes by id", () => {
		const msg = queue.addMessage("test")!
		expect(queue.removeMessage(msg.id)).toBe(true)
		expect(queue.isEmpty()).toBe(true)
	})

	it("removeMessage returns false for unknown id", () => {
		expect(queue.removeMessage("nonexistent")).toBe(false)
	})

	it("updateMessage updates text and timestamp", () => {
		const msg = queue.addMessage("original")!
		const oldTs = msg.timestamp
		const updated = queue.updateMessage(msg.id, "updated")
		expect(updated).toBe(true)
		expect(queue.messages[0]!.text).toBe("updated")
		expect(queue.messages[0]!.timestamp).toBeGreaterThanOrEqual(oldTs)
	})

	it("updateMessage returns false for unknown id", () => {
		expect(queue.updateMessage("unknown", "x")).toBe(false)
	})

	it("dispose clears messages and listeners", () => {
		queue.addMessage("test")
		const spy = vi.fn()
		queue.on("stateChanged", spy)
		queue.dispose()
		expect(queue.isEmpty()).toBe(true)
		queue.addMessage("after")
		expect(spy).not.toHaveBeenCalled() // listener removed
	})

	it("multiple adds emit stateChanged each time", () => {
		const spy = vi.fn()
		queue.on("stateChanged", spy)
		queue.addMessage("a")
		queue.addMessage("b")
		queue.addMessage("c")
		expect(spy).toHaveBeenCalledTimes(3)
	})

	it("dequeue emits stateChanged", () => {
		queue.addMessage("test")
		const spy = vi.fn()
		queue.on("stateChanged", spy)
		queue.dequeueMessage()
		expect(spy).toHaveBeenCalledTimes(1)
	})
})
