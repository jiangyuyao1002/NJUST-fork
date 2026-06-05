/**
 * Single source of truth for secret-detection patterns.
 *
 * Used by:
 *   - BashCommandAnalyzer (runtime command / file-content scanning)
 *   - scripts/check-secrets.mjs (pre-commit hook)
 *
 * Every entry carries both `reason` (runtime messages) and `name`
 * (pre-commit display). Callers pick whichever field they need.
 */

export interface SecretPattern {
	pattern: RegExp
	/** Runtime detection message (BashCommandAnalyzer) */
	reason: string
	/** Human-readable label (check-secrets.mjs) */
	name: string
}

export const SECRET_PATTERNS: SecretPattern[] = [
	// ── Private keys ──────────────────────────────────────────────────
	{
		pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
		reason: "Private key detected",
		name: "Private key",
	},

	// ── Cloud provider keys ──────────────────────────────────────────
	{
		pattern: /AKIA[0-9A-Z]{16}/,
		reason: "AWS Access Key ID detected",
		name: "AWS access key",
	},

	// ── GitHub tokens ────────────────────────────────────────────────
	{
		pattern: /ghp_[a-zA-Z0-9]{36}/,
		reason: "GitHub personal access token detected",
		name: "GitHub personal access token",
	},
	{
		pattern: /gho_[a-zA-Z0-9]{36}/,
		reason: "GitHub OAuth token detected",
		name: "GitHub OAuth token",
	},
	{
		pattern: /ghs_[a-zA-Z0-9]{36}/,
		reason: "GitHub server-to-server token detected",
		name: "GitHub server-to-server token",
	},
	{
		pattern: /github_pat_[a-zA-Z0-9]{22,}/,
		reason: "GitHub fine-grained PAT detected",
		name: "GitHub PAT",
	},

	// ── OpenAI / xAI ─────────────────────────────────────────────────
	{
		pattern: /sk-[a-zA-Z0-9]{20,}/,
		reason: "OpenAI API key detected",
		name: "OpenAI API key (sk-...)",
	},
	{
		pattern: /pk-[a-zA-Z0-9]{20,}/,
		reason: "OpenAI public key detected",
		name: "OpenAI public key (pk-...)",
	},
	{
		pattern: /xai-[a-zA-Z0-9]{20,}/,
		reason: "xAI API key detected",
		name: "xAI API key",
	},

	// ── Anthropic ────────────────────────────────────────────────────
	{
		pattern: /ant-api[a-zA-Z0-9_-]{20,}/i,
		reason: "Anthropic API key detected",
		name: "Anthropic API key",
	},

	// ── Slack ────────────────────────────────────────────────────────
	{
		pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}(-[a-zA-Z0-9]{24})?/,
		reason: "Slack token detected",
		name: "Slack token",
	},

	// ── JWT ──────────────────────────────────────────────────────────
	{
		pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/,
		reason: "JWT token detected",
		name: "JWT token",
	},

	// ── Generic key-value patterns ───────────────────────────────────
	{
		pattern: /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}["']?/i,
		reason: "API key detected",
		name: "JSON API key",
	},
	{
		pattern: /password\s*[:=]\s*["'][^"']{8,}["']/i,
		reason: "Hard-coded password detected",
		name: "Password",
	},
	{
		pattern: /secret\s*[:=]\s*["'][^"']{8,}["']/i,
		reason: "Hard-coded secret detected",
		name: "Hard-coded secret",
	},
	{
		pattern: /token\s*[:=]\s*["'][^"']{8,}["']/i,
		reason: "Hard-coded token detected",
		name: "Hard-coded token",
	},

	// ── .env file variables (check-secrets.mjs only — has fileName guard) ─
	{
		pattern: /^[A-Z_]+=/m,
		reason: "Environment variable in .env file",
		name: "Environment variable in .env file",
	},
]

/**
 * Scan `content` for secret patterns. Returns the list of matched reasons.
 */
export function detectSecretsInContent(content: string): { found: boolean; reasons: string[] } {
	const reasons: string[] = []
	for (const { pattern, reason } of SECRET_PATTERNS) {
		if (pattern.test(content)) {
			reasons.push(reason)
		}
	}
	return { found: reasons.length > 0, reasons }
}
