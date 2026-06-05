import { Package } from "@shared/package"

export function getCallbackUrl(provider: string, uriScheme?: string) {
	return encodeURIComponent(`${uriScheme || "vscode"}://${Package.publisher}.${Package.name}/${provider}`)
}

/**
 * Generate a cryptographically random state string for OAuth CSRF protection.
 * Uses crypto.getRandomValues when available, falls back to Math.random.
 */
function generateRandomState(): string {
	if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
		const arr = new Uint8Array(16)
		globalThis.crypto.getRandomValues(arr)
		return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("")
	}
	// Fallback (less secure but acceptable for VS Code webview context)
	return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
}

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 * Returns null if crypto.subtle is not available.
 */
async function generatePKCE(): Promise<{ verifier: string; challenge: string } | null> {
	try {
		if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) return null
		const verifierArr = new Uint8Array(32)
		globalThis.crypto.getRandomValues(verifierArr)
		const verifier = Array.from(verifierArr, (b) => b.toString(16).padStart(2, "0")).join("")
		const encoder = new TextEncoder()
		const data = encoder.encode(verifier)
		const digest = await globalThis.crypto.subtle.digest("SHA-256", data)
		const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "")
		return { verifier, challenge }
	} catch {
		return null
	}
}

export interface OAuthUrlResult {
	url: string
	state: string
	codeVerifier?: string
}

export async function getOpenRouterAuthUrl(uriScheme?: string): Promise<OAuthUrlResult> {
	const state = generateRandomState()
	const pkce = await generatePKCE()

	const callbackBase = `${uriScheme || "vscode"}://${Package.publisher}.${Package.name}/openrouter`
	const callbackWithState = encodeURIComponent(`${callbackBase}?state=${state}`)

	let url = `https://openrouter.ai/auth?callback_url=${callbackWithState}`
	if (pkce) {
		url += `&code_challenge=${pkce.challenge}&code_challenge_method=S256`
	}

	return { url, state, codeVerifier: pkce?.verifier }
}

export function getRequestyAuthUrl(uriScheme?: string) {
	return `https://app.requesty.ai/oauth/authorize?callback_url=${getCallbackUrl("requesty", uriScheme)}`
}
