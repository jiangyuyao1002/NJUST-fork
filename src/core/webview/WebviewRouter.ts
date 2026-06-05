import type * as vscode from "vscode"

import type { ExtensionMessage, ExtensionState } from "@njust-ai/types"

import { logger } from "../../shared/logger"

/** Warn threshold for serialized webview message payload (1 MB) */
const PAYLOAD_WARN_BYTES = 1 * 1024 * 1024
/** Truncate threshold for serialized webview message payload (5 MB) */
const PAYLOAD_TRUNCATE_BYTES = 5 * 1024 * 1024

export interface IWebviewRouterHost {
	isDisposed(): boolean
	getWebview(): vscode.Webview | undefined
	buildState(): Promise<ExtensionState>
}

export class WebviewRouter {
	constructor(private readonly host: IWebviewRouterHost) {}

	public async postMessage(message: ExtensionMessage): Promise<void> {
		if (this.host.isDisposed()) {
			return
		}

		try {
			const serialized = JSON.stringify(message)
			const sizeBytes = Buffer.byteLength(serialized, "utf-8")

			if (sizeBytes > PAYLOAD_TRUNCATE_BYTES) {
				logger.error(
					"WebviewRouter",
					`postMessage payload ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds ${Math.round(PAYLOAD_TRUNCATE_BYTES / 1024 / 1024)}MB limit (type: ${message.type}). Truncating large fields.`,
				)

				// For state messages, strip known large arrays and retry
				if (message.type === "state" && message.state) {
					const { taskHistory: _t, clineMessages: _c, ...truncatedState } = message.state
					await this.host.getWebview()?.postMessage({
						type: "state",
						state: { ...truncatedState, _truncated: true },
					})
				} else {
					logger.error("WebviewRouter", `Skipping undelivered message (type: ${message.type})`)
				}
				return
			}

			if (sizeBytes > PAYLOAD_WARN_BYTES) {
				logger.warn(
					"WebviewRouter",
					`postMessage payload ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds ${Math.round(PAYLOAD_WARN_BYTES / 1024 / 1024)}MB threshold (type: ${message.type}). Consider chunked delivery.`,
				)
			}

			await this.host.getWebview()?.postMessage(message)
		} catch (error) {
			logger.debug("ClineProvider", `postMessageToWebview: view disposed (message type: ${message.type})`, error)
		}
	}

	public async postState(): Promise<void> {
		const state = await this.host.buildState()
		await this.postMessage({ type: "state", state })
	}

	public async postStateWithoutTaskHistory(): Promise<void> {
		const state = await this.host.buildState()
		const { taskHistory: _omit, ...rest } = state
		await this.postMessage({ type: "state", state: rest })
	}

	public async postStateWithoutClineMessages(): Promise<void> {
		const state = await this.host.buildState()
		const { clineMessages: _omitMessages, taskHistory: _omitHistory, ...rest } = state
		await this.postMessage({ type: "state", state: rest })
	}
}
