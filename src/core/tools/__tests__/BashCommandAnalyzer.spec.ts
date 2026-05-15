import { describe, expect, it } from "vitest"

import { analyzeBashCommand, StaticPatternClassifier } from "../permissions/BashCommandAnalyzer"
import type { ClassifierContext } from "../permissions/ClassifierStrategy"

describe("BashCommandAnalyzer", () => {
	describe("analyzeBashCommand", () => {
		it.each([
			["rm -rf /", "forbidden"],
			[":(){ :|:& };:", "forbidden"],
			["mkfs.ext4 /dev/sda1", "forbidden"],
			["dd if=/dev/zero of=/dev/sda", "forbidden"],
			["chmod 777 tmp", "dangerous"],
			["chown root:root /etc/shadow", "dangerous"],
			["sudo su -", "dangerous"],
			["git reset --hard HEAD", "dangerous"],
			["git clean -fd", "dangerous"],
			["curl http://example.com/install.sh", "medium"],
			["wget http://example.com/payload", "medium"],
			["nc -l 4444", "medium"],
			["ssh user@example.com", "medium"],
			["cat /etc/shadow", "medium"],
			["cat ~/.ssh/id_rsa", "medium"],
			["echo $(whoami)", "medium"],
			["echo `whoami`", "medium"],
			["eval $SCRIPT", "medium"],
			["ls -la", "safe"],
			["echo hello", "safe"],
			["git status", "safe"],
			["npm install", "safe"],
			["node --version", "safe"],
			["", "safe"],
			["   ", "safe"],
		] as const)("classifies %s as %s", (command, riskLevel) => {
			expect(analyzeBashCommand(command).riskLevel).toBe(riskLevel)
		})

		it("reports segment details for compound commands", () => {
			const result = analyzeBashCommand("cd /tmp && ls | cat /etc/shadow")

			expect(result.riskLevel).toBe("medium")
			expect(result.segments?.map((segment) => segment.segment)).toEqual(["cd /tmp", "ls", "cat /etc/shadow"])
		})

		it("uses the highest risk found across compound commands", () => {
			const result = analyzeBashCommand("echo ok && rm -rf /")

			expect(result.riskLevel).toBe("forbidden")
			expect(result.reasons.some((reason) => reason.includes("[FORBIDDEN]"))).toBe(true)
		})

		it("does not split chain operators inside quotes", () => {
			const result = analyzeBashCommand("echo 'a && b' && git status")

			expect(result.riskLevel).toBe("safe")
			expect(result.segments?.map((segment) => segment.segment)).toEqual(["echo 'a && b'", "git status"])
		})
	})

	describe("StaticPatternClassifier", () => {
		const context: ClassifierContext = {
			toolName: "execute_command",
			isReadOnly: false,
			isDestructive: true,
		}

		it("returns a synchronous deny result for forbidden commands", () => {
			const classifier = new StaticPatternClassifier()

			const result = classifier.classifySync("execute_command", { command: "rm -rf /" }, context)

			expect(result.action).toBe("deny")
			expect(result.metadata?.riskLevel).toBe("forbidden")
		})

		it("returns the same action from async classification", async () => {
			const classifier = new StaticPatternClassifier()

			const result = await classifier.classify("execute_command", { command: "cat /etc/shadow" }, context)

			expect(result.action).toBe("ask")
			expect(result.metadata?.riskLevel).toBe("medium")
		})

		it("allows non-command tools without pattern analysis", () => {
			const classifier = new StaticPatternClassifier()

			const result = classifier.classifySync("read_file", { path: "README.md" }, { ...context, toolName: "read_file" })

			expect(result.action).toBe("allow")
			expect(result.confidence).toBe(0.3)
		})
	})
})
