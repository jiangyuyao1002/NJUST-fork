import { beforeEach, describe, expect, it, vi } from "vitest"

import { WebviewRouter, type IWebviewRouterHost } from "../WebviewRouter"

describe("WebviewRouter", () => {
	let postMessage: ReturnType<typeof vi.fn>
	let host: IWebviewRouterHost
	let router: WebviewRouter

	beforeEach(() => {
		postMessage = vi.fn().mockResolvedValue(true)
		host = {
			isDisposed: vi.fn(() => false),
			getWebview: vi.fn(
				() =>
					({
						postMessage,
					}) as any,
			),
			buildState: vi.fn().mockResolvedValue({
				clineMessages: ["message"],
				taskHistory: ["history"],
				version: "1.0.0",
			}),
		}
		router = new WebviewRouter(host)
	})

	it("does not post after disposal", async () => {
		vi.mocked(host.isDisposed).mockReturnValue(true)

		await router.postMessage({ type: "action", action: "chatButtonClicked" } as any)

		expect(postMessage).not.toHaveBeenCalled()
	})

	it("posts full state", async () => {
		await router.postState()

		expect(postMessage).toHaveBeenCalledWith({
			type: "state",
			state: expect.objectContaining({
				clineMessages: ["message"],
				taskHistory: ["history"],
			}),
		})
	})

	it("omits task history for lightweight state updates", async () => {
		await router.postStateWithoutTaskHistory()

		const message = postMessage.mock.calls[0]?.[0]
		expect(message.state.clineMessages).toEqual(["message"])
		expect(message.state.taskHistory).toBeUndefined()
	})

	it("omits messages and history for minimal state updates", async () => {
		await router.postStateWithoutClineMessages()

		const message = postMessage.mock.calls[0]?.[0]
		expect(message.state.clineMessages).toBeUndefined()
		expect(message.state.taskHistory).toBeUndefined()
		expect(message.state.version).toBe("1.0.0")
	})
})
