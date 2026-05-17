import type * as vscode from "vscode"

import type { ExtensionMessage, ExtensionState } from "@njust-ai-cj/types"

import { logger } from "../../shared/logger"

export interface WebviewRouterHost {
	isDisposed(): boolean
	getWebview(): vscode.Webview | undefined
	buildState(): Promise<ExtensionState>
}

export class WebviewRouter {
	constructor(private readonly host: WebviewRouterHost) {}

	public async postMessage(message: ExtensionMessage): Promise<void> {
		if (this.host.isDisposed()) {
			return
		}

		try {
			await this.host.getWebview()?.postMessage(message)
		} catch (error) {
			logger.debug("ClineProvider", `postMessageToWebview: view disposed (message type: ${message.type})`, error)
		}
	}

	public async postState(): Promise<void> {
		const state = await this.host.buildState()
		void this.postMessage({ type: "state", state })
	}

	public async postStateWithoutTaskHistory(): Promise<void> {
		const state = await this.host.buildState()
		const { taskHistory: _omit, ...rest } = state
		void this.postMessage({ type: "state", state: rest })
	}

	public async postStateWithoutClineMessages(): Promise<void> {
		const state = await this.host.buildState()
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		void this.postMessage({ type: "state", state: rest })
	}
}
