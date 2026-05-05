import { vi, describe, it, expect, beforeEach } from "vitest"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("MessageRouter", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		router = new MessageRouter()
		context = createMockContext()
	})

	it("routes to registered handler", async () => {
		const handler = vi.fn().mockResolvedValue(undefined)
		router.register("testType", handler)

		await router.route(context, { type: "testType" } as any)

		expect(handler).toHaveBeenCalledOnce()
		expect(handler).toHaveBeenCalledWith(context, { type: "testType" })
	})

	it("passes context and message to handler", async () => {
		const handler = vi.fn().mockResolvedValue(undefined)
		router.register("ping", handler)

		const message = { type: "ping", text: "hello" } as any
		await router.route(context, message)

		expect(handler).toHaveBeenCalledWith(context, message)
	})

	it("warns on unknown message type without throwing", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		await expect(router.route(context, { type: "unknownType" } as any)).resolves.not.toThrow()
		expect(warnSpy).toHaveBeenCalledWith("Unknown message type: unknownType")

		warnSpy.mockRestore()
	})

	it("overwrites handler on duplicate registration", async () => {
		const handler1 = vi.fn().mockResolvedValue(undefined)
		const handler2 = vi.fn().mockResolvedValue(undefined)

		router.register("dup", handler1)
		router.register("dup", handler2)

		await router.route(context, { type: "dup" } as any)

		expect(handler1).not.toHaveBeenCalled()
		expect(handler2).toHaveBeenCalledOnce()
	})

	it("handles multiple independent handler types", async () => {
		const handlerA = vi.fn().mockResolvedValue(undefined)
		const handlerB = vi.fn().mockResolvedValue(undefined)

		router.register("typeA", handlerA)
		router.register("typeB", handlerB)

		await router.route(context, { type: "typeA" } as any)
		await router.route(context, { type: "typeB" } as any)

		expect(handlerA).toHaveBeenCalledOnce()
		expect(handlerB).toHaveBeenCalledOnce()
	})
})
