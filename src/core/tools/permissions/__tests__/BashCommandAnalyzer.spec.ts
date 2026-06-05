vi.mock("../../../../shared/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import { describe, expect, it, vi } from "vitest"

import {
	analyzeBashCommand,
	BashCommandAnalyzer,
	StaticPatternClassifier,
} from "../BashCommandAnalyzer"
import type { ClassifierContext } from "../ClassifierStrategy"

// Shared context for classifier tests
const baseContext: ClassifierContext = {
	toolName: "execute_command",
	isReadOnly: false,
	isDestructive: false,
}

// ─── analyzeBashCommand ─────────────────────────────────────────────

describe("analyzeBashCommand", () => {
	// 1. Empty / whitespace commands
	describe("empty and whitespace commands", () => {
		it("returns safe for empty string", () => {
			const result = analyzeBashCommand("")
			expect(result.riskLevel).toBe("safe")
			expect(result.reasons).toContain("Empty command")
		})

		it("returns safe for whitespace-only string", () => {
			const result = analyzeBashCommand("   \t\n  ")
			expect(result.riskLevel).toBe("safe")
			expect(result.reasons).toContain("Empty command")
		})
	})

	// 2. Safe commands
	describe("safe commands", () => {
		it.each([
			["ls", "ls"],
			["echo hello", "echo hello"],
			["pwd", "pwd"],
			["cat file.txt", "cat file.txt"],
		])("returns safe for: %s", (cmd) => {
			const result = analyzeBashCommand(cmd)
			expect(result.riskLevel).toBe("safe")
			expect(result.reasons).toHaveLength(0)
		})
	})

	// 3. Forbidden commands
	describe("forbidden commands", () => {
		it("detects rm -rf /", () => {
			const result = analyzeBashCommand("rm -rf /")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("rm -rf /"))).toBe(true)
		})

		it("detects rm -rf / with trailing args", () => {
			// rm -rf / --no-preserve-root: the regex matches rm -rf / followed by space
			const result = analyzeBashCommand("rm -rf / --no-preserve-root")
			expect(result.riskLevel).toBe("forbidden")
		})

		it("detects sudo rm", () => {
			const result = analyzeBashCommand("sudo rm -rf /tmp/test")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("sudo rm"))).toBe(true)
		})

		it("detects dd with if/of", () => {
			const result = analyzeBashCommand("dd if=/dev/zero of=/dev/sda bs=1M")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("dd"))).toBe(true)
		})

		it("detects fork bomb", () => {
			const result = analyzeBashCommand(":(){ :|:& };:")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("Fork bomb"))).toBe(true)
		})

		it("detects mkfs", () => {
			const result = analyzeBashCommand("mkfs.ext4 /dev/sda1")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("mkfs"))).toBe(true)
		})

		it("detects format C:", () => {
			const result = analyzeBashCommand("format C:")
			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((r) => r.includes("format"))).toBe(true)
		})
	})

	// 4. Dangerous commands
	describe("dangerous commands", () => {
		it("detects rm file", () => {
			const result = analyzeBashCommand("rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.reasons.some((r) => r.includes("rm"))).toBe(true)
		})

		it("detects chmod 777", () => {
			const result = analyzeBashCommand("chmod 777 /var/www")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.reasons.some((r) => r.includes("chmod 777"))).toBe(true)
		})

		it("detects kill -9", () => {
			const result = analyzeBashCommand("kill -9 1234")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.reasons.some((r) => r.includes("kill -9"))).toBe(true)
		})

		it("detects git push --force", () => {
			const result = analyzeBashCommand("git push origin main --force")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.reasons.some((r) => r.includes("git push --force"))).toBe(true)
		})

		it("detects git reset --hard", () => {
			const result = analyzeBashCommand("git reset --hard HEAD~3")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.reasons.some((r) => r.includes("git reset --hard"))).toBe(true)
		})
	})

	// 5. Medium — network commands
	describe("medium risk: network commands", () => {
		it("detects curl", () => {
			const result = analyzeBashCommand("curl https://example.com")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("curl"))).toBe(true)
		})

		it("detects wget", () => {
			const result = analyzeBashCommand("wget https://example.com/file")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("wget"))).toBe(true)
		})

		it("detects ssh", () => {
			const result = analyzeBashCommand("ssh user@host")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("ssh"))).toBe(true)
		})

		it("detects nc (netcat)", () => {
			const result = analyzeBashCommand("nc -l 4444")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("nc"))).toBe(true)
		})
	})

	// 6. Medium — sensitive file access
	describe("medium risk: sensitive file access", () => {
		it("detects /etc/passwd access", () => {
			const result = analyzeBashCommand("cat /etc/passwd")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("/etc/passwd"))).toBe(true)
		})

		it("detects SSH private key access", () => {
			const result = analyzeBashCommand("cat ~/.ssh/id_rsa")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("SSH private key"))).toBe(true)
		})

		it("detects AWS credentials access", () => {
			const result = analyzeBashCommand("cat ~/.aws/credentials")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("AWS credentials"))).toBe(true)
		})
	})

	// 7. Medium — subshell / command substitution
	describe("medium risk: subshell and command substitution", () => {
		it("detects $(...) substitution", () => {
			const result = analyzeBashCommand("echo $(whoami)")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("Command substitution"))).toBe(true)
		})

		it("detects backtick substitution", () => {
			const result = analyzeBashCommand("echo `whoami`")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("Backtick"))).toBe(true)
		})

		it("detects eval", () => {
			const result = analyzeBashCommand("eval $USER_INPUT")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("eval"))).toBe(true)
		})

		it("detects exec", () => {
			const result = analyzeBashCommand("exec /bin/sh")
			expect(result.riskLevel).toBe("medium")
			expect(result.reasons.some((r) => r.includes("exec"))).toBe(true)
		})
	})

	// 8. Multi-segment commands — highest risk wins
	describe("multi-segment commands", () => {
		it("pipe: safe | dangerous → dangerous", () => {
			const result = analyzeBashCommand("ls | rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
			expect(result.segments).toBeDefined()
			expect(result.segments!.length).toBe(2)
		})

		it("chain: safe && dangerous → dangerous", () => {
			const result = analyzeBashCommand("echo hello && rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
		})

		it("semicolon: safe ; forbidden → forbidden", () => {
			const result = analyzeBashCommand("echo hello ; rm -rf /")
			expect(result.riskLevel).toBe("forbidden")
		})

		it("||: safe || dangerous → dangerous", () => {
			const result = analyzeBashCommand("ls || rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
		})

		it("pipe: safe | medium → medium", () => {
			const result = analyzeBashCommand("ls | curl https://example.com")
			expect(result.riskLevel).toBe("medium")
		})
	})

	// 9. Quoted pipes should NOT be split
	describe("quoted pipes not split", () => {
		it("double-quoted pipe stays as single segment", () => {
			const result = analyzeBashCommand('echo "hello | world"')
			expect(result.riskLevel).toBe("safe")
			// Should be a single segment — no pipe split inside quotes
			expect(result.segments).toBeUndefined()
		})

		it("single-quoted pipe stays as single segment", () => {
			const result = analyzeBashCommand("echo 'hello | world'")
			expect(result.riskLevel).toBe("safe")
			expect(result.segments).toBeUndefined()
		})
	})

	// 10. Risk aggregation
	describe("risk aggregation across segments", () => {
		it("safe + dangerous → dangerous", () => {
			const result = analyzeBashCommand("echo hello && rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
		})

		it("medium + dangerous → dangerous", () => {
			const result = analyzeBashCommand("curl https://example.com && rm file.txt")
			expect(result.riskLevel).toBe("dangerous")
		})

		it("medium + forbidden → forbidden", () => {
			const result = analyzeBashCommand("curl https://example.com && rm -rf /")
			expect(result.riskLevel).toBe("forbidden")
		})

		it("collects reasons from all segments", () => {
			const result = analyzeBashCommand("curl https://example.com | rm file.txt")
			expect(result.reasons.length).toBeGreaterThanOrEqual(2)
		})
	})

	// 16. BashCommandAnalyzer.analyze() delegates correctly
	describe("BashCommandAnalyzer.analyze()", () => {
		it("delegates to analyzeBashCommand for safe command", () => {
			const result = BashCommandAnalyzer.analyze("ls")
			expect(result.riskLevel).toBe("safe")
		})

		it("delegates to analyzeBashCommand for forbidden command", () => {
			const result = BashCommandAnalyzer.analyze("rm -rf /")
			expect(result.riskLevel).toBe("forbidden")
		})

		it("delegates to analyzeBashCommand for empty command", () => {
			const result = BashCommandAnalyzer.analyze("")
			expect(result.riskLevel).toBe("safe")
			expect(result.reasons).toContain("Empty command")
		})
	})
})

// ─── StaticPatternClassifier ────────────────────────────────────────

describe("StaticPatternClassifier", () => {
	const classifier = new StaticPatternClassifier()

	it("has name 'static-pattern'", () => {
		expect(classifier.name).toBe("static-pattern")
	})

	it("has high confidence", () => {
		expect(classifier.confidence).toBe("high")
	})

	// 11. execute_command + forbidden → deny
	describe("classifySync: execute_command", () => {
		it("returns deny for forbidden command", () => {
			const result = classifier.classifySync(
				"execute_command",
				{ command: "rm -rf /" },
				baseContext,
			)
			expect(result.action).toBe("deny")
			expect(result.confidence).toBe(1.0)
			expect(result.metadata?.riskLevel).toBe("forbidden")
		})

		// 12. execute_command + safe → allow
		it("returns allow for safe command", () => {
			const result = classifier.classifySync(
				"execute_command",
				{ command: "ls -la" },
				baseContext,
			)
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.5)
			expect(result.metadata?.riskLevel).toBe("safe")
		})

		it("returns ask for dangerous command", () => {
			const result = classifier.classifySync(
				"execute_command",
				{ command: "rm file.txt" },
				baseContext,
			)
			expect(result.action).toBe("ask")
			expect(result.confidence).toBe(0.9)
			expect(result.metadata?.riskLevel).toBe("dangerous")
		})

		it("returns ask for medium risk command", () => {
			const result = classifier.classifySync(
				"execute_command",
				{ command: "curl https://example.com" },
				baseContext,
			)
			expect(result.action).toBe("ask")
			expect(result.confidence).toBe(0.7)
			expect(result.metadata?.riskLevel).toBe("medium")
		})

		it("ignores non-string command input", () => {
			const result = classifier.classifySync(
				"execute_command",
				{ command: 12345 },
				baseContext,
			)
			// Falls through to default allow
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})
	})

	// 13. write_to_file + secret content → deny
	describe("classifySync: write_to_file", () => {
		it("returns deny for content with private key", () => {
			const result = classifier.classifySync(
				"write_to_file",
				{ content: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow..." },
				{ ...baseContext, toolName: "write_to_file" },
			)
			expect(result.action).toBe("deny")
			expect(result.confidence).toBe(0.95)
			expect(result.reason).toContain("Secrets detected")
			expect(result.reason).toContain("Private key")
		})

		it("returns deny for content with AWS access key", () => {
			const result = classifier.classifySync(
				"write_to_file",
				{ content: "aws_access_key_id = AKIAIOSFODNN7EXAMPLE" },
				{ ...baseContext, toolName: "write_to_file" },
			)
			expect(result.action).toBe("deny")
			expect(result.reason).toContain("AWS Access Key")
		})

		it("returns deny for content with GitHub token", () => {
			const result = classifier.classifySync(
				"write_to_file",
				{ content: "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" },
				{ ...baseContext, toolName: "write_to_file" },
			)
			expect(result.action).toBe("deny")
			expect(result.reason).toContain("GitHub")
		})

		// 14. write_to_file + normal content → allow (falls through to default)
		it("returns allow for normal content", () => {
			const result = classifier.classifySync(
				"write_to_file",
				{ content: "console.log('hello world');" },
				{ ...baseContext, toolName: "write_to_file" },
			)
			// No secrets detected → falls through to default
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})

		it("ignores non-string content input", () => {
			const result = classifier.classifySync(
				"write_to_file",
				{ content: 42 },
				{ ...baseContext, toolName: "write_to_file" },
			)
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})
	})

	// 14b. Other write tools with secret content → deny
	describe("classifySync: all write tools detect secrets", () => {
		const writeToolCases: Array<{ toolName: string; field: string; secretValue: string }> = [
			{ toolName: "edit_file", field: "new_string", secretValue: "AKIAIOSFODNN7EXAMPLE" },
			{ toolName: "edit", field: "new_string", secretValue: "sk-abcdefghijklmnopqrstuvwxyz1234" },
			{ toolName: "apply_diff", field: "diff", secretValue: "+ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij" },
			{ toolName: "search_replace", field: "new_string", secretValue: "-----BEGIN PRIVATE KEY-----" },
			{ toolName: "apply_patch", field: "patch", secretValue: "+password = 'supersecretpassword1'" },
		]

		for (const { toolName, field, secretValue } of writeToolCases) {
			it(`${toolName}: denies when ${field} contains secrets`, () => {
				const result = classifier.classifySync(
					toolName,
					{ [field]: secretValue },
					{ ...baseContext, toolName },
				)
				expect(result.action).toBe("deny")
				expect(result.confidence).toBe(0.95)
				expect(result.reason).toContain(`Secrets detected in ${toolName}`)
			})
		}

		it("allows write tools with clean content", () => {
			const result = classifier.classifySync(
				"edit",
				{ new_string: "const greeting = 'hello world';" },
				{ ...baseContext, toolName: "edit" },
			)
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})
	})

	// 15. Unrelated tool → low-confidence allow
	describe("classifySync: unrelated tool", () => {
		it("returns low-confidence allow for unknown tool", () => {
			const result = classifier.classifySync(
				"read_file",
				{ path: "/some/file.txt" },
				{ ...baseContext, toolName: "read_file" },
			)
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
			expect(result.reason).toBe("No pattern analysis needed")
		})

		it("returns low-confidence allow for list_files tool", () => {
			const result = classifier.classifySync(
				"list_files",
				{ path: "/home" },
				{ ...baseContext, toolName: "list_files" },
			)
			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})
	})

	// async classify() delegates to classifySync()
	describe("classify (async)", () => {
		it("returns same result as classifySync", async () => {
			const syncResult = classifier.classifySync(
				"execute_command",
				{ command: "ls" },
				baseContext,
			)
			const asyncResult = await classifier.classify(
				"execute_command",
				{ command: "ls" },
				baseContext,
			)
			expect(asyncResult).toEqual(syncResult)
		})
	})

	// startSpeculativeClassify
	describe("startSpeculativeClassify", () => {
		it("resolves with classification result", async () => {
			const result = await classifier.startSpeculativeClassify(
				"execute_command",
				{ command: "rm -rf /" },
				baseContext,
			)
			expect(result.action).toBe("deny")
			expect(result.metadata?.riskLevel).toBe("forbidden")
		})
	})
})
