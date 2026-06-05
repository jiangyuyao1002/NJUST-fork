import type { WebviewMessage, GlobalState } from "@njust-ai/types"
import { defaultModeSlug } from "../../shared/modes"
import type { ClineProvider } from "./ClineProvider"
import { MessageRouter, type MessageHandlerContext } from "./handlers/MessageRouter"
import { registerSettingsHandlers } from "./handlers/settingsMessageHandler"
import { registerTaskHandlers } from "./handlers/taskMessageHandler"
import { registerMcpHandlers } from "./handlers/mcpMessageHandler"
import { registerIndexingHandlers } from "./handlers/indexingMessageHandler"
import { registerChatHandlers } from "./handlers/chatMessageHandler"
import { registerModeHandlers } from "./handlers/modeHandler"

const router = new MessageRouter()
registerTaskHandlers(router)
registerSettingsHandlers(router)
registerMcpHandlers(router)
registerIndexingHandlers(router)
registerChatHandlers(router)
registerModeHandlers(router)

export const webviewMessageHandler = async (provider: ClineProvider, message: WebviewMessage) => {
	if (!message || typeof message !== "object") {
		throw new Error("Invalid webview message: expected non-null object")
	}

	const context: MessageHandlerContext = {
		provider,
		getGlobalState: <K extends keyof GlobalState>(key: K) => provider.contextProxy.getValue(key),
		updateGlobalState: async <K extends keyof GlobalState>(key: K, value: GlobalState[K]) =>
			provider.contextProxy.setValue(key, value),
		getCurrentCwd: () => provider.getCurrentTask()?.cwd || provider.cwd,
		getCurrentMode: async (): Promise<string> => {
			const currentTask = provider.getCurrentTask()
			if (currentTask) {
				try {
					return await currentTask.getTaskMode()
				} catch (error) {
					provider.log(
						`Error resolving current task mode: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
					)
				}
			}
			try {
				const state = await provider.getState()
				if (typeof state.mode === "string" && state.mode.length > 0) {
					return state.mode
				}
			} catch (error) {
				provider.log(
					`Error resolving global mode: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
				)
			}
			return defaultModeSlug
		},
	}
	await router.route(context, message)
}
