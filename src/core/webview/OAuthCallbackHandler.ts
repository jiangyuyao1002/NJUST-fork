/**
 * OAuth callback handling for API providers (OpenRouter, Requesty).
 * Extracted from ClineProvider to reduce coupling.
 */
import axios from "axios"
import { openRouterDefaultModelId, requestyDefaultModelId } from "@njust-ai/core/providers"
import { REQUESTY_BASE_URL } from "../../shared/utils/requesty"
import type { ProviderSettings } from "@njust-ai/types"

interface OAuthHost {
	getState(): Promise<{ apiConfiguration: ProviderSettings; currentApiConfigName?: string }>
	upsertProviderProfile(name: string, config: ProviderSettings): Promise<unknown>
	log(message: string): void
}

export async function handleOpenRouterCallback(
	host: OAuthHost,
	code: string,
	codeVerifier?: string,
): Promise<void> {
	const { apiConfiguration, currentApiConfigName = "default" } = await host.getState()

	let apiKey: string

	try {
		const baseUrl = apiConfiguration.openRouterBaseUrl || "https://openrouter.ai/api/v1"
		const baseUrlDomain = baseUrl.match(/^(https?:\/\/[^/]+)/)?.[1] || "https://openrouter.ai"

		// Include code_verifier for PKCE if available (best-effort; OpenRouter may ignore it)
		const requestBody: Record<string, string> = { code }
		if (codeVerifier) {
			requestBody.code_verifier = codeVerifier
		}

		const response = await axios.post(`${baseUrlDomain}/api/v1/auth/keys`, requestBody)

		if (response.data?.key) {
			apiKey = response.data.key
		} else {
			throw new Error("Invalid response from OpenRouter API")
		}
	} catch (error) {
		host.log(`Error exchanging code for API key: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`)
		throw error
	}

	const newConfiguration: ProviderSettings = {
		...apiConfiguration,
		apiProvider: "openrouter",
		openRouterApiKey: apiKey,
		openRouterModelId: apiConfiguration?.openRouterModelId || openRouterDefaultModelId,
	}

	await host.upsertProviderProfile(currentApiConfigName, newConfiguration)
}

export async function handleRequestyCallback(host: OAuthHost, code: string, baseUrl: string | null): Promise<void> {
	const { apiConfiguration } = await host.getState()

	const newConfiguration: ProviderSettings = {
		...apiConfiguration,
		apiProvider: "requesty",
		requestyApiKey: code,
		requestyModelId: apiConfiguration?.requestyModelId || requestyDefaultModelId,
	}

	if (!baseUrl || baseUrl === REQUESTY_BASE_URL) {
		newConfiguration.requestyBaseUrl = undefined
	} else {
		newConfiguration.requestyBaseUrl = baseUrl
	}

	const profileName = `Requesty (${new Date().toLocaleString()})`
	await host.upsertProviderProfile(profileName, newConfiguration)
}
