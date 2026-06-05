#!/usr/bin/env node

/**
 * Lightweight secrets scanner for pre-commit checks.
 * Scans staged files for patterns that look like API keys, tokens, or credentials.
 *
 * Usage:
 *   git diff --cached --name-only | node scripts/check-secrets.mjs
 *
 * Returns exit code 1 if potential secrets are found.
 */

import { readFileSync } from "fs"
import { execSync } from "child_process"
import { createInterface } from "readline"

// Patterns that indicate potential secrets.
// SINGLE SOURCE OF TRUTH (runtime): packages/core/src/security/secretPatterns.ts
// This list MUST stay in sync with the TypeScript module above.
// A Vitest test in packages/core enforces this invariant.
const SECRET_PATTERNS = [
	// Private keys
	{ pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, name: "Private key" },
	// Cloud provider keys
	{ pattern: /AKIA[0-9A-Z]{16}/, name: "AWS access key" },
	// GitHub tokens
	{ pattern: /ghp_[a-zA-Z0-9]{36}/, name: "GitHub personal access token" },
	{ pattern: /gho_[a-zA-Z0-9]{36}/, name: "GitHub OAuth token" },
	{ pattern: /ghs_[a-zA-Z0-9]{36}/, name: "GitHub server-to-server token" },
	{ pattern: /github_pat_[a-zA-Z0-9]{22,}/, name: "GitHub PAT" },
	// OpenAI / xAI
	{ pattern: /sk-[a-zA-Z0-9]{20,}/, name: "OpenAI API key (sk-...)" },
	{ pattern: /pk-[a-zA-Z0-9]{20,}/, name: "OpenAI public key (pk-...)" },
	{ pattern: /xai-[a-zA-Z0-9]{20,}/, name: "xAI API key" },
	// Anthropic
	{ pattern: /ant-api[a-zA-Z0-9_-]{20,}/i, name: "Anthropic API key" },
	// Slack
	{ pattern: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}(-[a-zA-Z0-9]{24})?/, name: "Slack token" },
	// JWT
	{ pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/, name: "JWT token" },
	// Generic key-value patterns
	{ pattern: /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}["']?/i, name: "JSON API key" },
	{ pattern: /password\s*[:=]\s*["'][^"']{8,}["']/i, name: "Password" },
	{ pattern: /secret\s*[:=]\s*["'][^"']{8,}["']/i, name: "Hard-coded secret" },
	{ pattern: /token\s*[:=]\s*["'][^"']{8,}["']/i, name: "Hard-coded token" },
	// .env files with secrets (fileName guard applied below)
	{ pattern: /^[A-Z_]+=/m, fileName: /\.env$/, name: "Environment variable in .env file" },
]

const patterns = SECRET_PATTERNS

const ALLOWLISTED_FINDINGS = [
	{
		file: /^\.njust-ai\/skills\/cangjie-full-docs\/libs_stdx\/logger\/logger_samples\/logger_sample\.md$/,
		name: "Password",
	},
	{ file: /^CangjieCorpus-1\.0\.0\/libs\/stdx\/logger\/logger_samples\/logger_sample\.md$/, name: "Password" },
	{ file: /^src\/utils\/__tests__\/git\.spec\.ts$/, name: "GitHub personal access token" },
	{ file: /^webview-ui\/src\/i18n\/locales\/(?:en|zh-CN|zh-TW)\/settings\.json$/, name: "JSON API key" },
	{
		file: /^src\/core\/tools\/permissions\/__tests__\/BashCommandAnalyzer\.spec\.ts$/,
		name: "GitHub personal access token",
	},
	{ file: /^src\/core\/tools\/permissions\/__tests__\/BashCommandAnalyzer\.spec\.ts$/, name: "AWS access key" },
	{ file: /^src\/core\/tools\/permissions\/__tests__\/BashCommandAnalyzer\.spec\.ts$/, name: "Private key" },
]

function normalizePath(file) {
	return file.replaceAll("\\", "/")
}

function isAllowlisted(file, name) {
	const normalized = normalizePath(file)
	return ALLOWLISTED_FINDINGS.some((entry) => entry.name === name && entry.file.test(normalized))
}

async function main() {
	const isAllFiles = process.argv.includes("--all-files")
	const isStaged = process.argv.includes("--staged")
	const files = []

	if (isAllFiles) {
		try {
			const output = execSync("git ls-files", { encoding: "utf-8", stdio: "pipe" })
			files.push(...output.trim().split("\n").filter(Boolean))
		} catch {
			console.log("Not a git repo; scanning src/ directly.")
			const { readdirSync, statSync } = await import("fs")
			const { join } = await import("path")
			function walk(dir) {
				for (const name of readdirSync(dir)) {
					const p = join(dir, name)
					if (name === "node_modules" || name.startsWith(".")) continue
					if (statSync(p).isDirectory()) walk(p)
					else files.push(p)
				}
			}
			for (const d of ["src", "packages", "apps", "scripts"]) {
				try {
					walk(d)
				} catch {}
			}
		}
	} else if (isStaged) {
		try {
			const output = execSync("git diff --cached --name-only --diff-filter=ACMR", {
				encoding: "utf-8",
				stdio: "pipe",
			})
			files.push(...output.trim().split("\n").filter(Boolean))
		} catch {
			console.log("Not a git repo; scanning all tracked files.")
			const output = execSync("git ls-files", { encoding: "utf-8", stdio: "pipe" })
			files.push(...output.trim().split("\n").filter(Boolean))
		}
	} else {
		const stdin = createInterface({ input: process.stdin })
		for await (const line of stdin) {
			const file = line.trim()
			if (file) files.push(file)
		}
	}

	if (files.length === 0) {
		console.log("✅ No files to check.")
		process.exit(0)
	}

	let foundIssues = false

	for (const file of files) {
		// Skip binary files, lock files, and generated files
		if (
			file.endsWith(".lock") ||
			file.endsWith(".png") ||
			file.endsWith(".jpg") ||
			file.endsWith(".svg") ||
			file.endsWith(".vsix") ||
			file.match(/\.code-workspace$/)
		) {
			continue
		}

		let content
		try {
			content = readFileSync(file, "utf-8")
		} catch {
			continue // Binary or deleted file
		}

		// Check each pattern
		for (const { pattern, name, fileName } of patterns) {
			// If the pattern has a fileName matcher, check the file name first
			if (fileName && !fileName.test(file)) continue
			if (pattern.test(content)) {
				if (isAllowlisted(file, name)) continue

				if (!foundIssues) {
					console.log("\n⚠️  Potential secrets detected in staged files:\n")
					foundIssues = true
				}
				console.log(`  📄 ${file} — may contain: ${name} (${pattern})`)
			}
		}
	}

	if (foundIssues) {
		console.log("\n❌ Commit blocked. Please remove secrets before committing.")
		console.log("   If these are false positives, use `git commit --no-verify` to bypass.\n")
		process.exit(1)
	}

	console.log("✅ No secrets detected in staged files.")
}

main().catch((err) => {
	console.error("Secret check failed:", err)
	process.exit(1)
})
