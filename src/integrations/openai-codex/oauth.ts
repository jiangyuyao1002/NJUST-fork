// OAuth manager stub for OpenAI Codex
// This is a stub since we've removed the actual OAuth implementation

export const openAiCodexOAuthManager = {
	getAccessToken(): string | null {
		return null
	},

	forceRefreshAccessToken(): string | null {
		return null
	},

	getAccountId(): string | null {
		return null
	},

	isAuthenticated(): boolean {
		return false
	},

	initialize(_context: any, _messageCallback: (message: string) => void): void {
		// Stub - no-op
	},

	startAuthorizationFlow(): string {
		// Stub - return empty URL
		return ""
	},

	waitForCallback(): { success: boolean; error?: string } {
		// Stub - return failure
		return { success: false }
	},

	async clearCredentials(): Promise<void> {
		// Stub - no-op
	}
}
