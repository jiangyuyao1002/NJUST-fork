export type CommandRiskLevel = "low" | "medium" | "high"

export interface CommandRiskReport {
	level: CommandRiskLevel
	reasons: string[]
}

const HIGH_RISK_PATTERNS: RegExp[] = [
	/\brm\b\s+(-[a-z]*[rf][a-z]*\s+)?(\/|\.|\*|~|\$)/i,
	/\b(del|erase|rmdir)\b/i,
	/\bremove-item\b/i,
	/\b(format|mkfs|diskpart|dd)\b/i,
	/\b(chmod|chown|icacls)\b/i,
	/\b(userdel|usermod|net\s+user|passwd)\b/i,
	/\b(kill|pkill|taskkill|Stop-Process)\b/i,
	/\bgit\s+(reset\s+--hard|push\s+--force|clean\s+-fd)/i,
	/\bset-executionpolicy\b/i,
	/\b(new-item|set-content|add-content|out-file)\b.+\b(force|append)\b/i,
	/\b(reg\s+add|reg\s+delete|Set-ItemProperty|Remove-ItemProperty)\b/i,
	/\bStart-BitsTransfer\b/i,
]

const MEDIUM_RISK_PATTERNS: RegExp[] = [
	/\b(git\s+commit|git\s+push|git\s+merge|git\s+rebase)\b/i,
	/\b(npm|pnpm|yarn|pip|uv|poetry)\s+(install|add|remove|update)\b/i,
	/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i,
	/\b(sc\s+(start|stop|config)|Set-Service|Restart-Service)\b/i,
	/\b(copy-item|move-item|rename-item|xcopy|robocopy)\b/i,
]

const EXEC_CHAIN_PATTERNS: RegExp[] = [/\|/, /&&/, /;/, />|<</, /\$\(/, /`[^`]+`/]

export function assessCommandRisk(command: string): CommandRiskReport {
	const raw = command?.trim() ?? ""
	if (!raw) {
		return { level: "high", reasons: ["Empty command was rejected."] }
	}

	const reasons: string[] = []
	const lower = raw.toLowerCase()

	for (const p of HIGH_RISK_PATTERNS) {
		if (p.test(raw)) {
			reasons.push(`Matched high-risk pattern: ${p.source}`)
		}
	}

	for (const p of EXEC_CHAIN_PATTERNS) {
		if (p.test(raw)) {
			reasons.push(`Contains shell composition/operator: ${p.source}`)
		}
	}

	for (const p of MEDIUM_RISK_PATTERNS) {
		if (p.test(raw)) {
			reasons.push(`Matched medium-risk pattern: ${p.source}`)
		}
	}

	if (reasons.some((r) => r.includes("high-risk"))) {
		return { level: "high", reasons }
	}

	const hasOperator = reasons.some((r) => r.includes("composition/operator"))
	const hasMedium = reasons.some((r) => r.includes("medium-risk"))
	if (hasOperator || hasMedium) {
		return { level: "medium", reasons }
	}

	if (/(^|\s)(ls|dir|pwd|echo|cat|type|git\s+status|git\s+diff)(\s|$)/i.test(lower)) {
		return { level: "low", reasons: ["Read-oriented command pattern detected."] }
	}

	return { level: "medium", reasons: ["Unknown command defaults to medium risk."] }
}
