/**
 * OpenAI Codex rate limits - stub for simplified version
 */

export interface RateLimitInfo {
	limit: number
	remaining: number
	reset: number
	primary?: RateLimitInfo
	usedPercent?: number
	resetsAt?: string | number
	fetchedAt?: number
}

export async function fetchOpenAiCodexRateLimitInfo(
	_accessToken: string,
	_options?: { accountId?: string | null },
): Promise<RateLimitInfo | undefined> {
	// No-op in simplified version
	return undefined
}
