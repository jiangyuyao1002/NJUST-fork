import type { ProviderSettings } from "@njust-ai-cj/types"

/**
 * Prefer enabling parallel native tool calls only when the user explicitly turns
 * `parallelToolCalls` on in the current API profile (many OpenAI-compatible backends reject or mishandle the flag).
 */
export function resolveParallelNativeToolCalls(apiConfiguration: ProviderSettings | undefined): boolean {
	return apiConfiguration?.parallelToolCalls === true
}
