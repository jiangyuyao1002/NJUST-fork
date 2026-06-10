import type { ClineProvider } from "../ClineProvider"
import type { WebviewMessage, GlobalState } from "@njust-ai/types"
import { logger } from "../../../shared/logger"

export type MessageHandler = (context: MessageHandlerContext, message: WebviewMessage) => void | Promise<void>

export interface MessageHandlerContext {
	provider: ClineProvider
	getGlobalState: <K extends keyof GlobalState>(key: K) => GlobalState[K] | undefined
	updateGlobalState: <K extends keyof GlobalState>(key: K, value: GlobalState[K]) => Promise<void>
	getCurrentCwd: () => string
	getCurrentMode: () => Promise<string>
}

export class MessageRouter {
	private handlers = new Map<string, MessageHandler>()

	register(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler)
	}

	async route(context: MessageHandlerContext, message: WebviewMessage): Promise<void> {
		if (!message || typeof message !== "object" || !message.type) {
			logger.warn("MessageRouter", "Rejected malformed webview message")
			return
		}

		const handler = this.handlers.get(message.type)
		if (handler) {
			await handler(context, message)
		} else {
			// Only registered handler types are allowed — the handler map
			// itself acts as the allowlist, preventing XSS from posting
			// arbitrary message types to the extension host.
			logger.warn("MessageRouter", `Rejected unknown message type: ${message.type}`)
		}
	}
}
