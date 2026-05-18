import * as vscode from "vscode"

import { getVisibleInstance } from "./providerActionDispatcher"

export interface IUriCallbackHandler {
	handleOpenRouterCallback(code: string): Promise<void>
	handleRequestyCallback(code: string, baseUrl: string | null): Promise<void>
}

let uriCallbackHandler: IUriCallbackHandler | undefined

export function registerUriCallbackHandler(handler: IUriCallbackHandler): void {
	uriCallbackHandler = handler
}

export const handleUri = async (uri: vscode.Uri) => {
	const path = uri.path
	const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
	const visibleProvider = getVisibleInstance() as IUriCallbackHandler | undefined

	if (!visibleProvider && !uriCallbackHandler) {
		return
	}

	const handler = visibleProvider ?? uriCallbackHandler!

	switch (path) {
		case "/openrouter": {
			const code = query.get("code")
			if (code) {
				await handler.handleOpenRouterCallback(code)
			}
			break
		}
		case "/requesty": {
			const code = query.get("code")
			const baseUrl = query.get("baseUrl")
			if (code) {
				await handler.handleRequestyCallback(code, baseUrl)
			}
			break
		}
		default:
			break
	}
}
