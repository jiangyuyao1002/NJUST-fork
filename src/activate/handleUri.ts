import * as vscode from "vscode"

import { getVisibleInstance } from "./providerActionDispatcher"

/** Maximum age for OAuth state before it is considered expired (10 minutes). */
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000

export interface IUriCallbackHandler {
	handleOpenRouterCallback(code: string, codeVerifier?: string): Promise<void>
	handleRequestyCallback(code: string, baseUrl: string | null): Promise<void>
	pendingOAuthState?: {
		state: string
		codeVerifier?: string
		provider: "openrouter" | "requesty"
		expectedBaseUrl?: string
		createdAt: number
	}
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

			if (pendingState.provider !== "openrouter") {
				vscode.window.showErrorMessage("OpenRouter OAuth rejected: state was issued for a different provider.")
				break
			}

			if (Date.now() - pendingState.createdAt > OAUTH_STATE_MAX_AGE_MS) {
				vscode.window.showErrorMessage(
					"OpenRouter OAuth rejected: state has expired. Please restart authentication.",
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
			const returnedState = query.get("state")

			if (!code) break

			// CSRF protection: validate state parameter matches the pending state
			// set by the webview before the OAuth redirect.
			const pendingState = handler.pendingOAuthState
			handler.pendingOAuthState = undefined

			if (!pendingState || !returnedState) {
				vscode.window.showErrorMessage("Requesty OAuth authentication rejected: missing CSRF state parameter.")
				break
			}

			if (pendingState.provider !== "requesty") {
				vscode.window.showErrorMessage("Requesty OAuth rejected: state was issued for a different provider.")
				break
			}

			if (Date.now() - pendingState.createdAt > OAUTH_STATE_MAX_AGE_MS) {
				vscode.window.showErrorMessage(
					"Requesty OAuth rejected: state has expired. Please restart authentication.",
				)
				break
			}

			if (returnedState !== pendingState.state) {
				vscode.window.showErrorMessage(
					"Requesty OAuth state mismatch detected. Authentication rejected for security.",
				)
				break
			}

			// Verify the callback baseUrl matches the URL configured at OAuth initiation.
			// This prevents an attacker from redirecting the callback to a different endpoint.
			// When expectedBaseUrl was recorded, the callback MUST provide a matching baseUrl.
			if (pendingState.expectedBaseUrl) {
				if (!baseUrl) {
					vscode.window.showErrorMessage("Requesty OAuth rejected: callback missing expected base URL.")
					break
				}
				try {
					const expectedOrigin = new URL(pendingState.expectedBaseUrl).origin
					const actualOrigin = new URL(baseUrl).origin
					if (expectedOrigin !== actualOrigin) {
						vscode.window.showErrorMessage(
							"Requesty OAuth rejected: callback base URL does not match the configured endpoint.",
						)
						break
					}
				} catch {
					vscode.window.showErrorMessage("Requesty OAuth rejected: invalid base URL format.")
					break
				}
			}

			await handler.handleRequestyCallback(code, baseUrl)
			break
		}
		default:
			break
	}
}
