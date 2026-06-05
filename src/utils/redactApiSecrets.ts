/**
 * Removes likely API key material from strings before logging or surfacing errors.
 */

const BEARER_RE = /Bearer\s+[A-Za-z0-9\-._~+/=]+/gi
const SK_PREFIX_RE = /\bsk-[A-Za-z0-9]{8,}\b/g
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g

export function redactApiSecrets(text: string): string {
	if (!text) {
		return text
	}
	let s = text
	s = s.replace(BEARER_RE, "Bearer [REDACTED]")
	s = s.replace(SK_PREFIX_RE, "sk-[REDACTED]")
	s = s.replace(AWS_ACCESS_KEY_RE, "AKIA[REDACTED]")
	s = s.replace(
		/\b(api[_-]?key|apikey|authorization|x-api-key)\s*[=:]\s*["']?[^\s"'<>\r\n]{6,}/gi,
		"$1=[REDACTED]",
	)
	return s
}

export function redactApiSecretsFromErrorMessage(err: unknown): string {
	if (err instanceof Error) {
		return redactApiSecrets(err.message)
	}
	return redactApiSecrets(String(err))
}
