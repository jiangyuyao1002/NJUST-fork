/**
 * Command safety pre-check layer.
 *
 * Delegates shell-level analysis to BashCommandAnalyzer (single source of truth)
 * and adds supplementary pattern detection for SQL, environment manipulation,
 * and an explicit allowlist override.
 */

import { analyzeBashCommand, type BashAnalysisResult, type RiskLevel } from "../permissions/BashCommandAnalyzer"
import { containsDangerousSubstitution } from "@njust-ai/core/auto-approval"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"

// ── SQL destructive patterns ─────────────────────────────────────────

const SQL_DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i, reason: "SQL DROP — destructive schema operation" },
	{ pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "SQL TRUNCATE TABLE — deletes all rows" },
	{ pattern: /\bDELETE\s+FROM\b/i, reason: "SQL DELETE FROM — row deletion" },
	{ pattern: /\bALTER\s+TABLE\s+.*\bDROP\b/i, reason: "SQL ALTER TABLE DROP — column/constraint removal" },
]

// ── Environment / config mutation patterns ────────────────────────────

const ENV_MUTATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bexport\s+[A-Z_]+=/, reason: "Exports environment variable in current shell" },
	{ pattern: /\bunset\s+[A-Z_]+/, reason: "Unsets environment variable" },
	{ pattern: /\breg\s+(add|delete)\b/i, reason: "Windows registry modification" },
]

// ── Allowlist ────────────────────────────────────────────────────────

/**
 * Commands that are always safe regardless of pattern matches.
 * Matched against the first whitespace-delimited token of the command.
 */
const ALLOWLISTED_PREFIXES = new Set([
	"echo",
	"printf",
	"cat",
	"head",
	"tail",
	"wc",
	"ls",
	"dir",
	"pwd",
	"cd",
	"type",
	"which",
	"where",
	"whoami",
	"date",
	"hostname",
	"uname",
])

export interface CommandSafetyResult {
	safe: boolean
	riskLevel: RiskLevel
	reasons: string[]
	requiresConfirmation: boolean
	shellAnalysis: BashAnalysisResult
}

/**
 * Pre-check a command for safety before execution.
 *
 * Returns a unified result combining BashCommandAnalyzer output with
 * supplementary SQL/env checks. The caller decides how to surface this
 * to the user (e.g., warning banner, blocking confirmation dialog).
 */
export function checkCommandSafety(command: string): CommandSafetyResult {
	// Unescape HTML entities first so that &amp;&amp; etc. are caught by safety checks
	const trimmed = unescapeHtmlEntities(command).trim()
	if (!trimmed) {
		return {
			safe: true,
			riskLevel: "safe",
			reasons: [],
			requiresConfirmation: false,
			shellAnalysis: { riskLevel: "safe", reasons: [] },
		}
	}

	const shellAnalysis = analyzeBashCommand(trimmed)
	const firstToken = trimmed.split(/\s/)[0]!.replace(/^\.\//, "")
	const hasChainOrPipe = /[|;&]|\$\(|`/.test(trimmed)
	if (ALLOWLISTED_PREFIXES.has(firstToken) && !hasChainOrPipe && shellAnalysis.riskLevel === "safe") {
		return {
			safe: true,
			riskLevel: "safe",
			reasons: [],
			requiresConfirmation: false,
			shellAnalysis,
		}
	}

	const extraReasons: string[] = []
	let risk = shellAnalysis.riskLevel

	for (const { pattern, reason } of SQL_DANGEROUS_PATTERNS) {
		if (pattern.test(trimmed)) {
			extraReasons.push(`[SQL] ${reason}`)
			risk = riskMax(risk, "dangerous")
		}
	}

	for (const { pattern, reason } of ENV_MUTATION_PATTERNS) {
		if (pattern.test(trimmed)) {
			extraReasons.push(`[ENV] ${reason}`)
			risk = riskMax(risk, "medium")
		}
	}

	// Unified dangerous shell substitution detection (was previously only in auto-approval)
	if (containsDangerousSubstitution(trimmed)) {
		extraReasons.push("[Shell] Dangerous parameter substitution or process substitution detected")
		risk = riskMax(risk, "dangerous")
	}

	const allReasons = [...shellAnalysis.reasons, ...extraReasons]
	const requiresConfirmation = risk === "dangerous" || risk === "forbidden"

	return {
		safe: risk === "safe",
		riskLevel: risk,
		reasons: allReasons,
		requiresConfirmation,
		shellAnalysis,
	}
}

// ── helpers ──────────────────────────────────────────────────────────

const RISK_ORDER: Record<RiskLevel, number> = { safe: 0, medium: 1, dangerous: 2, forbidden: 3 }

function riskMax(a: RiskLevel, b: RiskLevel): RiskLevel {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}
