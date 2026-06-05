import * as vscode from "vscode"

import { getVisibleInstance } from "./providerActionDispatcher"

export interface IUriCallbackHandler {
	handleOpenRouterCallback(code: string, codeVerifier?: string): Promise<void>
	handleRequestyCallback(code: string, baseUrl: string | null): Promise<void>
	pendingOAuthState?: { state: string; codeVerifier?: string }
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
			const returnedState = query.get("state")

			if (!code) break

			// Reject authentication when CSRF protection state is missing.
			// Both the pending state (set by webview before redirect) and the returned
			// state (from the OAuth callback) must be present and match.
			const pendingState = handler.pendingOAuthState
			handler.pendingOAuthState = undefined

			if (!pendingState || !returnedState) {
				vscode.window.showErrorMessage(
					"OpenRouter OAuth authentication rejected: missing CSRF state parameter.",
				)
				break
			}

			if (returnedState !== pendingState.state) {
				vscode.window.showErrorMessage(
					"OpenRouter OAuth state mismatch detected. Authentication rejected for security.",
				)
				break
			}

			const codeVerifier = pendingState.codeVerifier
			await handler.handleOpenRouterCallback(code, codeVerifier)
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
