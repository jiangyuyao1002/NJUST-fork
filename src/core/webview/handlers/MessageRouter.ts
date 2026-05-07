import type { ClineProvider } from "../ClineProvider"
import type { WebviewMessage, GlobalState } from "@njust-ai-cj/types"
import { logger } from "../../../shared/logger"

export type MessageHandler = (context: MessageHandlerContext, message: WebviewMessage) => Promise<void>

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
		const handler = this.handlers.get(message.type)
		if (handler) {
			await handler(context, message)
		} else {
			logger.warn("MessageRouter", `Unknown message type: ${message.type}`)
		}
	}
}
