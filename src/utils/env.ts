/**
 * Strips sensitive environment variables before passing env to AI-initiated subprocesses.
 *
 * The extension host environment may contain API keys, tokens, and credentials that
 * should not be visible to LLM-invoked shell commands. This filter removes well-known
 * secret patterns while preserving standard system variables.
 */

const SENSITIVE_ENV_PATTERNS = [
	/_TOKEN$/i,
	/_SECRET$/i,
	/_PASSWORD$/i,
	/_PASSWD$/i,
	/_CREDENTIALS?$/i,
	/_API_KEY$/i,
	/_ACCESS_KEY$/i,
	/_PRIVATE_KEY$/i,
	/_SIGNING_KEY$/i,
	/^AWS_SECRET_/i,
	/^AWS_ACCESS_KEY_ID$/i,
	/^AWS_SESSION_TOKEN$/i,
	/^NPM_TOKEN$/i,
	/^GITHUB_TOKEN$/i,
	/^OPENAI_API_KEY$/i,
	/^ANTHROPIC_API_KEY$/i,
	/^GOOGLE_APPLICATION_CREDENTIALS$/i,
	/^AZURE_CLIENT_SECRET$/i,
	/^AZURE_STORAGE_KEY$/i,
	/^DOCKER_AUTH/i,
	/^NUGET_KEY$/i,
	/^PYPI_TOKEN$/i,
	/^TWINE_PASSWORD$/i,
	/^COCOAPODS_TRUNK_TOKEN$/i,
	/^COMPOSER_AUTH$/i,
]

function isSensitiveEnvKey(key: string): boolean {
	return SENSITIVE_ENV_PATTERNS.some((p) => p.test(key))
}

export function filterSensitiveEnv(
	extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (!isSensitiveEnvKey(key)) {
			filtered[key] = value
		}
	}
	if (extra) {
		Object.assign(filtered, extra)
	}
	return filtered
}
