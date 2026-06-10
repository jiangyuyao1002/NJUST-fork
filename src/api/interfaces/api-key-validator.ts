/**
 * Shared validation utilities for API providers
 */

/**
 * Validates that an API key is provided and not empty.
 * Throws a clear error message if the key is missing or undefined.
 *
 * @param key - The API key to validate
 * @param providerName - The name of the provider for the error message
 * @returns The validated API key
 * @throws Error if the API key is not provided
 *
 * @example
 * // In a provider constructor
 * this.apiKey = requireApiKey(options.apiKey, "OpenAI")
 */
export function requireApiKey(key: string | undefined, providerName: string): string {
	if (!key || key === "not-provided") {
		throw new Error(
			`${providerName} API key is required. Please configure it in settings. ` +
				`You can set it via the VS Code settings under "Njust-AI.${providerName.toLowerCase()}ApiKey" ` +
				`or via the environment variable.`,
		)
	}
	return key
}

/**
 * Validates an API key with a custom error message.
 *
 * @param key - The API key to validate
 * @param providerName - The name of the provider
 * @param customMessage - Custom error message to display
 * @returns The validated API key
 * @throws Error if the API key is not provided
 */
export function requireApiKeyWithMessage(key: string | undefined, providerName: string, customMessage: string): string {
	if (!key || key === "not-provided") {
		throw new Error(`${providerName} API key is required. ${customMessage}`)
	}
	return key
}
