/**
 * Strips sensitive environment variables before passing env to AI-initiated subprocesses.
 *
 * The extension host environment may contain API keys, tokens, and credentials that
 * should not be visible to LLM-invoked shell commands. This filter removes well-known
 * secret patterns while preserving standard system variables.
 */

import { logger } from "../shared/logger"

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

/**
 * Dangerous environment variables that should never be injected from MCP config.
 * These can be used for code execution, library hijacking, or privilege escalation.
 */
export const DANGEROUS_ENV_KEYS = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"BASH_ENV",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"GEM_PATH",
	"RUBYLIB",
	"PERL5LIB",
	"PERLLIB",
])

/**
 * PATH-like variables that should be appended (user value first) rather than overwritten.
 */
export const PATH_KEYS = new Set(["PATH", "PATHEXT"])

/**
 * Safely merges user-provided environment variables into defaults.
 * - Drops keys in DANGEROUS_ENV_KEYS and logs a warning.
 * - Appends PATH-like variables instead of replacing them.
 */
function findPathKeyInDefaults(
	defaults: Record<string, string | undefined>,
	upperKey: string,
): string | undefined {
	if (PATH_KEYS.has(upperKey)) {
		for (const k of Object.keys(defaults)) {
			if (k.toUpperCase() === upperKey) {
				return k
			}
		}
	}
	return undefined
}

export function mergeSafeEnv(
	defaults: Record<string, string | undefined>,
	userEnv: Record<string, string | undefined>,
	contextLabel?: string,
): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = { ...defaults }
	const pathDelimiter = process.platform === "win32" ? ";" : ":"

	for (const [key, value] of Object.entries(userEnv)) {
		const upperKey = key.toUpperCase()

		if (DANGEROUS_ENV_KEYS.has(upperKey)) {
			logger.warn(
				"StdioTransport",
				`${contextLabel ? `[${contextLabel}] ` : ""}Blocked dangerous env variable: ${key}`,
			)
			continue
		}

		const pathKey = findPathKeyInDefaults(merged, upperKey)
		if (pathKey && typeof value === "string" && merged[pathKey]) {
			merged[pathKey] = `${value}${pathDelimiter}${merged[pathKey]}`
		} else {
			merged[key] = value
		}
	}

	return merged
}
