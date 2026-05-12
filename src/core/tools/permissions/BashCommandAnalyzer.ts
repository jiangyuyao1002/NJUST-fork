/**
 * BashCommandAnalyzer — systematic security analysis for shell commands.
 *
 * Replaces the simple pattern checks in ExecuteCommandTool with a multi-dimensional
 * risk assessment. Each command (including piped/chained segments) is analyzed for:
 *   - Forbidden patterns (catastrophic system damage)
 *   - Dangerous patterns (destructive but potentially legitimate)
 *   - Network operations (data exfiltration risk)
 *   - Privilege escalation (sudo, su)
 *   - Sensitive file access (/etc/passwd, ~/.ssh/*)
 *   - Command substitution / subshell detection
 *
 * The overall risk level is the *highest* risk found across all segments.
 *
 * Also implements ClassifierStrategy as StaticPatternClassifier, enabling
 * pluggable classification in the PermissionRuleEngine classifier chain.
 */

import type { ClassifierStrategy, ClassifierContext, ClassifyResult } from "./ClassifierStrategy"

export type RiskLevel = "safe" | "medium" | "dangerous" | "forbidden"

export interface BashAnalysisResult {
	/** The highest risk level detected across all command segments. */
	riskLevel: RiskLevel
	/** Human-readable reasons explaining why this risk level was assigned. */
	reasons: string[]
	/** Individual segment analyses (for piped/chained commands). */
	segments?: Array<{ segment: string; riskLevel: RiskLevel; reasons: string[] }>
}

// ── Pattern definitions ──────────────────────────────────────────────

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\brm\s+(-[^\s]*)?-rf\s+\/(?:\s|$)/, reason: "rm -rf / — catastrophic recursive deletion of root filesystem" },
	{ pattern: /\bsudo\s+rm\b/, reason: "sudo rm — privileged deletion" },
	{ pattern: /\bdd\s+.*\bif=.*\bof=/, reason: "dd with if/of — raw disk write, potential data destruction" },
	{ pattern: /:\(\)\{\s*:\|\s*:&\s*\}\s*;?\s*:/, reason: "Fork bomb detected" },
	{ pattern: /\bmkfs\b/, reason: "mkfs — filesystem format command" },
	{ pattern: /\b>\s*\/dev\/[sh]d[a-z]/, reason: "Direct write to block device" },
	{ pattern: /\bformat\s+[a-zA-Z]:/, reason: "Windows format drive command" },
]

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\brm\s/, reason: "rm — file deletion" },
	{ pattern: /\btruncate\b/, reason: "truncate — file truncation" },
	{ pattern: />\s*\/etc\//, reason: "Redirect into /etc/ — system config modification" },
	{ pattern: /\bchmod\s+777\b/, reason: "chmod 777 — world-writable permissions" },
	{ pattern: /\bchown\b/, reason: "chown — ownership change" },
	{ pattern: /\bkill\s+-9\b/, reason: "kill -9 — forced process termination" },
	{ pattern: /\bshutdown\b/, reason: "shutdown command" },
	{ pattern: /\breboot\b/, reason: "reboot command" },
	{ pattern: /\bgit\s+push\s+.*--force\b/, reason: "git push --force — destructive force push" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard — discard all local changes" },
	{ pattern: /\bgit\s+clean\s+-[^\s]*f/, reason: "git clean -f — delete untracked files" },
]

const NETWORK_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bcurl\s/, reason: "curl — HTTP request" },
	{ pattern: /\bwget\s/, reason: "wget — file download" },
	{ pattern: /\bnc\s/, reason: "nc (netcat) — network connection" },
	{ pattern: /\bssh\s/, reason: "ssh — remote shell connection" },
	{ pattern: /\bscp\s/, reason: "scp — remote file copy" },
	{ pattern: /\brsync\s/, reason: "rsync — remote file sync" },
	{ pattern: /\btelnet\s/, reason: "telnet — remote connection" },
	{ pattern: /\bnmap\b/, reason: "nmap — network scanner" },
]

const PRIVILEGE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bsudo\s/, reason: "sudo — privilege escalation" },
	{ pattern: /\bsu\s+-c\b/, reason: "su -c — run as another user" },
	{ pattern: /\bdoas\s/, reason: "doas — privilege escalation" },
	{ pattern: /\bpkexec\b/, reason: "pkexec — PolicyKit privilege escalation" },
]

const SENSITIVE_FILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\/etc\/passwd\b/, reason: "Access to /etc/passwd" },
	{ pattern: /\/etc\/shadow\b/, reason: "Access to /etc/shadow — password hashes" },
	{ pattern: /~\/\.ssh\/id_rsa\b/, reason: "Access to SSH private key" },
	{ pattern: /~\/\.ssh\/id_ed25519\b/, reason: "Access to SSH private key (ed25519)" },
	{ pattern: /~\/\.ssh\//, reason: "Access to ~/.ssh/ directory" },
	{ pattern: /\/etc\/sudoers\b/, reason: "Access to sudoers file" },
	{ pattern: /~\/\.aws\/credentials\b/, reason: "Access to AWS credentials" },
	{ pattern: /~\/\.aws\/config\b/, reason: "Access to AWS config" },
	{ pattern: /~\/\.env\b/, reason: "Access to dotenv file" },
	{ pattern: /\.pem\b/, reason: "Access to PEM certificate/key file" },
	{ pattern: /\.p12\b/, reason: "Access to PKCS#12 key file" },
	{ pattern: /~\/\.gnupg\//, reason: "Access to GnuPG directory" },
	{ pattern: /~\/\.docker\/config\.json\b/, reason: "Access to Docker credentials" },
	{ pattern: /~\/\.kube\/config\b/, reason: "Access to Kubernetes config" },
	{ pattern: /~\/\.npmrc\b/, reason: "Access to npm config (may contain auth tokens)" },
	{ pattern: /~\/\.pypirc\b/, reason: "Access to PyPI credentials" },
]

// ── Command substitution / subshell patterns ─────────────────────────

const COMMAND_SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\$\(.*\)/, reason: "Command substitution $(...) — nested command execution" },
	{ pattern: /`[^`]+`/, reason: "Backtick command substitution — nested command execution" },
	{ pattern: /\beval\s/, reason: "eval — dynamic code execution" },
	{ pattern: /\bexec\s/, reason: "exec — replace current process" },
	{ pattern: /\bsource\s/, reason: "source — execute script in current shell" },
	{ pattern: /\b\.\s+\//, reason: "dot-source — execute script in current shell" },
]

// ── Risk level ordering ──────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = {
	safe: 0,
	medium: 1,
	dangerous: 2,
	forbidden: 3,
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

/**
 * Map RiskLevel to ClassifyResult action.
 */
function riskToAction(risk: RiskLevel): "allow" | "deny" | "ask" {
	switch (risk) {
		case "forbidden":
			return "deny"
		case "dangerous":
			return "ask"
		case "medium":
			return "ask"
		case "safe":
			return "allow"
	}
}

/**
 * Map RiskLevel to confidence score.
 */
function riskToConfidence(risk: RiskLevel): number {
	switch (risk) {
		case "forbidden":
			return 1.0
		case "dangerous":
			return 0.9
		case "medium":
			return 0.7
		case "safe":
			return 0.5
	}
}

// ── Segment splitting ────────────────────────────────────────────────

/**
 * Split a command string into segments by pipes (|) and chain operators (&&, ||, ;).
 * Respects single/double quotes — doesn't split inside quoted strings.
 */
function splitCommandSegments(command: string): string[] {
	const segments: string[] = []
	let current = ""
	let inSingleQuote = false
	let inDoubleQuote = false
	let i = 0

	while (i < command.length) {
		const ch = command[i]

		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote
			current += ch
			i++
			continue
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote
			current += ch
			i++
			continue
		}

		if (!inSingleQuote && !inDoubleQuote) {
			if (ch === "|" || ch === ";") {
				segments.push(current.trim())
				current = ""
				// Skip || and |
				if (ch === "|" && command[i + 1] === "|") {
					i += 2
				} else {
					i++
				}
				continue
			}
			if (ch === "&" && command[i + 1] === "&") {
				segments.push(current.trim())
				current = ""
				i += 2
				continue
			}
		}

		current += ch
		i++
	}

	if (current.trim()) {
		segments.push(current.trim())
	}

	return segments.filter((s) => s.length > 0)
}

// ── Analyzer ─────────────────────────────────────────────────────────

function analyzeSegment(segment: string): { riskLevel: RiskLevel; reasons: string[] } {
	const reasons: string[] = []
	let risk: RiskLevel = "safe"

	// Check forbidden patterns
	for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[FORBIDDEN] ${reason}`)
			risk = maxRisk(risk, "forbidden")
		}
	}

	// Check dangerous patterns
	for (const { pattern, reason } of DANGEROUS_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[DANGEROUS] ${reason}`)
			risk = maxRisk(risk, "dangerous")
		}
	}

	// Check privilege escalation
	for (const { pattern, reason } of PRIVILEGE_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[PRIVILEGE] ${reason}`)
			risk = maxRisk(risk, "dangerous")
		}
	}

	// Check network operations
	for (const { pattern, reason } of NETWORK_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[NETWORK] ${reason}`)
			risk = maxRisk(risk, "medium")
		}
	}

	// Check sensitive file access
	for (const { pattern, reason } of SENSITIVE_FILE_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[SENSITIVE] ${reason}`)
			risk = maxRisk(risk, "medium")
		}
	}

	// Check command substitution / subshell
	for (const { pattern, reason } of COMMAND_SUBSTITUTION_PATTERNS) {
		if (pattern.test(segment)) {
			reasons.push(`[SUBSHELL] ${reason}`)
			risk = maxRisk(risk, "medium")
		}
	}

	return { riskLevel: risk, reasons }
}

/**
 * Analyze a shell command for security risks.
 *
 * Splits the command by pipes and chain operators, analyzes each segment
 * independently, then returns the highest risk level across all segments.
 */
export function analyzeBashCommand(command: string): BashAnalysisResult {
	if (!command || command.trim() === "") {
		return { riskLevel: "safe", reasons: ["Empty command"] }
	}

	const segments = splitCommandSegments(command)
	const segmentResults = segments.map((segment) => ({
		segment,
		...analyzeSegment(segment),
	}))

	let overallRisk: RiskLevel = "safe"
	const allReasons: string[] = []

	for (const seg of segmentResults) {
		overallRisk = maxRisk(overallRisk, seg.riskLevel)
		allReasons.push(...seg.reasons)
	}

	return {
		riskLevel: overallRisk,
		reasons: allReasons,
		segments: segmentResults.length > 1 ? segmentResults : undefined,
	}
}

/**
 * Convenience class wrapper for the analyzer.
 * Static methods allow use without instantiation.
 */
export class BashCommandAnalyzer {
	static analyze(command: string): BashAnalysisResult {
		return analyzeBashCommand(command)
	}
}

// ── ClassifierStrategy implementation ────────────────────────────────

/**
 * StaticPatternClassifier — wraps BashCommandAnalyzer as a ClassifierStrategy.
 *
 * This is the default classifier enabled in the PermissionRuleEngine.
 * It uses static regex patterns for high-confidence, zero-latency classification.
 *
 * Only activates for `execute_command` tool invocations with a string `command`
 * parameter. All other tools pass through with a neutral "allow" result.
 */
export class StaticPatternClassifier implements ClassifierStrategy {
	readonly name = "static-pattern"
	readonly confidence = "high" as const

	classifySync(
		toolName: string,
		input: Record<string, unknown>,
		_context: ClassifierContext,
	): ClassifyResult {
		if (toolName !== "execute_command" || typeof input.command !== "string") {
			return {
				action: "allow",
				reason: "Not a bash command — no pattern analysis needed",
				confidence: 0.3,
			}
		}

		const analysis = analyzeBashCommand(input.command)

		return {
			action: riskToAction(analysis.riskLevel),
			reason:
				analysis.reasons.length > 0 ? analysis.reasons.join("; ") : "No security risks detected",
			confidence: riskToConfidence(analysis.riskLevel),
			metadata: {
				riskLevel: analysis.riskLevel,
				patternCount: analysis.reasons.length,
				segments: analysis.segments?.length,
			},
		}
	}

	async classify(
		toolName: string,
		input: Record<string, unknown>,
		context: ClassifierContext,
	): Promise<ClassifyResult> {
		return this.classifySync(toolName, input, context)
	}

	/**
	 * Start speculative classification in background. Call as soon as
	 * the tool_use block arrives to pre-compute results before the
	 * permission check. Reduces perceived latency for the user.
	 */
	startSpeculativeClassify(
		toolName: string,
		input: Record<string, unknown>,
		context: ClassifierContext,
	): Promise<ClassifyResult> {
		return new Promise<ClassifyResult>((resolve) => {
			setImmediate(() => {
				try {
					resolve(this.classifySync(toolName, input, context))
				} catch {
					resolve({ action: "allow", reason: "Classifier error", confidence: 0 })
				}
			})
		})
	}
}
