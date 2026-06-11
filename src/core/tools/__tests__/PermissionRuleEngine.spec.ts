import { beforeEach, describe, expect, it, vi } from "vitest"
import { TEST_SK_DETECTION_VALUE } from "../../../__tests__/testConstants"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
}))

vi.mock("../../security/metrics", () => ({
	recordSecurityMetric: vi.fn(),
}))

vi.mock("../../../shared/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

import * as fs from "fs/promises"
import { recordSecurityMetric } from "../../security/metrics"
import type { ClassifierStrategy } from "../permissions/ClassifierStrategy"
import { PermissionRuleEngine, type ToolMetadata } from "../permissions/PermissionRuleEngine"
import type { PermissionRule } from "../permissions/PermissionRule"

const readOnly: ToolMetadata = { isReadOnly: true, isDestructive: false }
const writeTool: ToolMetadata = { isReadOnly: false, isDestructive: false }
const destructive: ToolMetadata = { isReadOnly: false, isDestructive: true }

function rule(
	partial: Partial<PermissionRule> & Pick<PermissionRule, "id" | "action" | "toolPattern">,
): PermissionRule {
	return {
		description: partial.id,
		priority: 0,
		...partial,
	}
}

function engineWithoutClassifiers(): PermissionRuleEngine {
	const engine = new PermissionRuleEngine()
	engine.setClassifierConfig({ enabledClassifiers: [] })
	return engine
}

describe("PermissionRuleEngine", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("mode handling", () => {
		it.each([
			["ask", "read_file", readOnly, "ask"],
			["auto", "read_file", readOnly, "allow"],
			["auto", "write_to_file", writeTool, "ask"],
			["default", "read_file", readOnly, "allow"],
			["default", "write_to_file", writeTool, "ask"],
			["default", "apply_diff", destructive, "ask"],
		] as const)("evaluates %s mode for %s as %s", (mode, toolName, meta, expected) => {
			const engine = engineWithoutClassifiers()
			engine.setMode(mode)

			expect(engine.evaluate(toolName, {}, meta)).toBe(expected)
		})

		it("allows non-hardened tools in bypass mode", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			expect(engine.evaluate("read_file", { path: "a.ts" }, readOnly)).toBe("allow")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_allow", expect.any(Object))
		})

		it("denies forbidden commands in bypass mode", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			expect(engine.evaluate("execute_command", { command: "rm -rf /" }, destructive)).toBe("deny")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_deny", expect.any(Object))
		})

		it("denies sensitive file reads in bypass mode", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			expect(engine.evaluate("execute_command", { command: "cat ~/.ssh/id_rsa" }, destructive)).toBe("deny")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_deny", expect.any(Object))
		})

		it("allows hardened tools in bypass mode when classifier passes", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			expect(engine.evaluate("write_to_file", { path: "a.ts", content: "hello" }, writeTool)).toBe("allow")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_allow", expect.any(Object))
		})

		it("denies write_to_file in bypass mode when secrets are detected", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			expect(
				engine.evaluate(
					"write_to_file",
					{ path: "config.ts", content: `const apiKey = '${TEST_SK_DETECTION_VALUE}'` },
					writeTool,
				),
			).toBe("deny")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_deny", expect.any(Object))
		})
	})

	describe("rule evaluation", () => {
		it("sorts rules by source priority before rule priority", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "session-allow", action: "allow", toolPattern: "read_file", priority: 1000 }))
			engine.addRule(
				rule({ id: "policy-deny", action: "deny", toolPattern: "read_file", priority: 1, source: "policy" }),
			)

			expect(engine.getRules().map((r) => r.id)).toEqual(["policy-deny", "session-allow"])
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("deny")
		})

		it.each([
			["*", "read_file"],
			["read_*", "read_file"],
			["*_file", "read_file"],
			["read_file", "read_file"],
		])("matches tool pattern %s against %s", (toolPattern, toolName) => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "allow", action: "allow", toolPattern }))

			expect(engine.evaluate(toolName, {}, writeTool)).toBe("allow")
		})

		it("skips rules when condition returns false", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "deny", action: "deny", toolPattern: "read_file", condition: () => false }))

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})

		it("prefers deny over allow and ask when multiple rules match", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "allow", action: "allow", toolPattern: "read_file" }))
			engine.addRule(rule({ id: "ask", action: "ask", toolPattern: "read_file" }))
			engine.addRule(rule({ id: "deny", action: "deny", toolPattern: "read_file" }))

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("deny")
			expect(engine.getDenialCount("read_file")).toBe(1)
		})

		it("removes rules by id", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "deny", action: "deny", toolPattern: "read_file" }))
			engine.removeRule("deny")

			expect(engine.getRules()).toHaveLength(0)
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})
	})

	describe("classifier chain", () => {
		it("uses static classifier for forbidden execute_command input", () => {
			const engine = new PermissionRuleEngine()

			expect(engine.evaluate("execute_command", { command: "rm -rf /" }, destructive)).toBe("deny")
			expect(engine.getDenialCount("execute_command")).toBe(1)
		})

		it("ignores classifier results below confidence threshold", () => {
			const classifier: ClassifierStrategy = {
				name: "low",
				confidence: "low",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "low confidence", confidence: 0.2 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["low"], minConfidenceThreshold: 0.9 })

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})

		it("skips duplicate classifier registration and supports unregister", () => {
			const classifier: ClassifierStrategy = {
				name: "custom",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "ask", reason: "custom", confidence: 1 }),
			}
			const engine = new PermissionRuleEngine()

			engine.registerClassifier(classifier)
			engine.registerClassifier(classifier)
			expect(engine.getClassifierNames().filter((name) => name === "custom")).toHaveLength(1)

			engine.unregisterClassifier("custom")
			expect(engine.getClassifierNames()).not.toContain("custom")
		})

		it("supports async classifiers through evaluateAsync", async () => {
			const classifier: ClassifierStrategy = {
				name: "async",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "ask", reason: "async", confidence: 1 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["async"] })

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("ask")
			expect(classifier.classify).toHaveBeenCalledWith(
				"write_to_file",
				{},
				expect.objectContaining({ toolName: "write_to_file" }),
			)
		})
	})

	describe("denial tracking", () => {
		it("records, resets, and expires denial counts", () => {
			vi.useFakeTimers()
			const engine = engineWithoutClassifiers()

			engine.recordDenial("execute_command")
			engine.recordDenial("execute_command")
			expect(engine.getDenialCount("execute_command")).toBe(2)

			vi.advanceTimersByTime(10 * 60 * 1000)
			expect(engine.getDenialCount("execute_command")).toBe(0)

			engine.recordDenial("execute_command")
			engine.resetDenials("execute_command")
			expect(engine.getDenialCount("execute_command")).toBe(0)
			vi.useRealTimers()
		})

		it("auto-downgrades repeated denials to ask", () => {
			const engine = engineWithoutClassifiers()
			engine.setClassifierConfig({ autoDowngradeAfterDenials: 2 })
			engine.recordDenial("write_to_file")
			engine.recordDenial("write_to_file")

			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
		})
	})

	describe("config persistence", () => {
		it("loads serialized rules and sorts them", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce(
				JSON.stringify({
					rules: [
						{ id: "session", description: "s", action: "allow", toolPattern: "*", priority: 100 },
						{
							id: "policy",
							description: "p",
							action: "deny",
							toolPattern: "*",
							priority: 1,
							source: "policy",
						},
					],
				}),
			)
			const engine = engineWithoutClassifiers()

			await engine.loadFromConfig("rules.json")

			expect(engine.getRules().map((r) => r.id)).toEqual(["policy", "session"])
		})

		it("throws when config has no rules array", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce("{}")
			const engine = new PermissionRuleEngine()

			await expect(engine.loadFromConfig("rules.json")).rejects.toThrow("Invalid permission config")
		})

		it("saves serializable rules without condition functions", async () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(
				rule({ id: "conditional", action: "allow", toolPattern: "read_file", condition: () => true }),
			)

			await engine.saveToConfig("rules.json")

			const [, content] = vi.mocked(fs.writeFile).mock.calls[0]!
			const parsed = JSON.parse(content as string)
			expect(parsed.rules[0].id).toBe("conditional")
			expect(parsed.rules[0]).not.toHaveProperty("condition")
		})
	})
})
