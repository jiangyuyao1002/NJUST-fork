import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
}))

vi.mock("../../../security/metrics", () => ({
	recordSecurityMetric: vi.fn(),
}))

vi.mock("../../../../shared/logger", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

import * as fs from "fs/promises"
import { recordSecurityMetric } from "../../../security/metrics"
import { logger } from "../../../../shared/logger"
import type { ClassifierStrategy, ClassifierChainConfig } from "../ClassifierStrategy"
import type { PermissionRule } from "../PermissionRule"
import { PermissionRuleEngine, type ToolMetadata } from "../PermissionRuleEngine"

// ── Helpers ──────────────────────────────────────────────────────────

const readOnly: ToolMetadata = { isReadOnly: true, isDestructive: false }
const writeTool: ToolMetadata = { isReadOnly: false, isDestructive: false }
const destructive: ToolMetadata = { isReadOnly: false, isDestructive: true }

function rule(partial: Partial<PermissionRule>): PermissionRule {
	return {
		id: "r1",
		description: partial.id ?? "r1",
		source: "user",
		toolPattern: "*",
		action: "allow",
		priority: 0,
		...partial,
	}
}

function engineWithoutClassifiers(): PermissionRuleEngine {
	const engine = new PermissionRuleEngine()
	engine.setClassifierConfig({ enabledClassifiers: [] })
	return engine
}

// ── Tests ────────────────────────────────────────────────────────────

describe("PermissionRuleEngine - Extended", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// ── 1. Default behavior without rules or classifiers ────────────

	describe("default behavior without rules or classifiers", () => {
		it("allows readOnly tool by default", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})

		it("asks for destructive tool by default", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.evaluate("apply_diff", {}, destructive)).toBe("ask")
		})

		it("asks for normal write tool by default", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
		})

		it("asks for unknown tool with write metadata", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.evaluate("unknown_tool", { foo: "bar" }, writeTool)).toBe("ask")
		})

		it("allows unknown tool with readOnly metadata", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.evaluate("list_files", {}, readOnly)).toBe("allow")
		})
	})

	// ── 2. Async evaluation path (evaluateAsync) ───────────────────

	describe("async evaluation path (evaluateAsync)", () => {
		it("denies forbidden commands in bypass mode via evaluateAsync", async () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			await expect(engine.evaluateAsync("execute_command", { command: "rm -rf /" }, destructive)).resolves.toBe(
				"deny",
			)
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_deny", expect.any(Object))
		})

		it("allows safe commands in bypass mode via evaluateAsync", async () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			await expect(engine.evaluateAsync("execute_command", { command: "ls" }, writeTool)).resolves.toBe("allow")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_allow", expect.any(Object))
		})

		it("returns ask in ask mode via evaluateAsync", async () => {
			const engine = engineWithoutClassifiers()
			engine.setMode("ask")

			await expect(engine.evaluateAsync("read_file", {}, readOnly)).resolves.toBe("ask")
		})

		it("allows readOnly in auto mode via evaluateAsync", async () => {
			const engine = engineWithoutClassifiers()
			engine.setMode("auto")

			await expect(engine.evaluateAsync("read_file", {}, readOnly)).resolves.toBe("allow")
		})

		it("asks for write tools in auto mode via evaluateAsync", async () => {
			const engine = engineWithoutClassifiers()
			engine.setMode("auto")

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("ask")
		})

		it("short-circuits on deny rule without running async classifiers", async () => {
			const engine = engineWithoutClassifiers()
			const asyncClassifier: ClassifierStrategy = {
				name: "async-test",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "allow", reason: "ok", confidence: 1 }),
			}
			engine.registerClassifier(asyncClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["async-test"] })
			engine.addRule(rule({ id: "deny-rule", action: "deny", toolPattern: "write_to_file" }))

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("deny")
			expect(asyncClassifier.classify).not.toHaveBeenCalled()
		})

		it("returns allow from allow rule without running async classifiers", async () => {
			const engine = engineWithoutClassifiers()
			const asyncClassifier: ClassifierStrategy = {
				name: "async-test",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "deny", reason: "no", confidence: 1 }),
			}
			engine.registerClassifier(asyncClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["async-test"] })
			engine.addRule(rule({ id: "allow-rule", action: "allow", toolPattern: "write_to_file" }))

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("allow")
			expect(asyncClassifier.classify).not.toHaveBeenCalled()
		})

		it("runs async classifier when no rules match and respects deny", async () => {
			const engine = engineWithoutClassifiers()
			const asyncClassifier: ClassifierStrategy = {
				name: "async-deny",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "deny", reason: "risky", confidence: 0.9 }),
			}
			engine.registerClassifier(asyncClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["async-deny"] })

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("deny")
			expect(asyncClassifier.classify).toHaveBeenCalled()
			expect(engine.getDenialCount("write_to_file")).toBe(1)
		})

		it("records denial in async path when classifier returns deny", async () => {
			const engine = engineWithoutClassifiers()
			const classifier: ClassifierStrategy = {
				name: "deny-classifier",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "deny", reason: "blocked", confidence: 1 }),
			}
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["deny-classifier"] })

			await engine.evaluateAsync("write_to_file", {}, writeTool)
			expect(engine.getDenialCount("write_to_file")).toBe(1)
		})

		it("applies denial auto-downgrade in async path", async () => {
			const engine = engineWithoutClassifiers()
			engine.setClassifierConfig({ autoDowngradeAfterDenials: 2 })
			engine.recordDenial("write_to_file")
			engine.recordDenial("write_to_file")

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("ask")
		})

		it("passes extra context to async classifiers", async () => {
			const engine = engineWithoutClassifiers()
			const classifier: ClassifierStrategy = {
				name: "ctx-check",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "ask", reason: "check", confidence: 1 }),
			}
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["ctx-check"] })

			await engine.evaluateAsync("write_to_file", {}, writeTool, { cwd: "/home/user", taskId: "task-42" })

			expect(classifier.classify).toHaveBeenCalledWith(
				"write_to_file",
				{},
				expect.objectContaining({ cwd: "/home/user", taskId: "task-42" }),
			)
		})

		it("returns ask when async classifier returns ask", async () => {
			const engine = engineWithoutClassifiers()
			const classifier: ClassifierStrategy = {
				name: "ask-classifier",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "ask", reason: "needs confirmation", confidence: 0.9 }),
			}
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["ask-classifier"] })

			await expect(engine.evaluateAsync("write_to_file", {}, writeTool)).resolves.toBe("ask")
		})
	})

	// ── 3. Classifier chain edge cases ─────────────────────────────

	describe("classifier chain edge cases", () => {
		it("silently ignores classifier that throws in sync path", () => {
			const throwingClassifier: ClassifierStrategy = {
				name: "thrower",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => {
					throw new Error("classifier exploded")
				},
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(throwingClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["thrower"] })

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
			expect(logger.warn).toHaveBeenCalledWith(
				"PermissionRuleEngine",
				expect.stringContaining("thrower"),
				expect.any(Error),
			)
		})

		it("silently ignores classifier that rejects in async path", async () => {
			const rejectingClassifier: ClassifierStrategy = {
				name: "rejector",
				confidence: "high",
				classify: vi.fn().mockRejectedValue(new Error("async failure")),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(rejectingClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["rejector"] })

			await expect(engine.evaluateAsync("read_file", {}, readOnly)).resolves.toBe("allow")
			expect(logger.warn).toHaveBeenCalledWith(
				"PermissionRuleEngine",
				expect.stringContaining("rejector"),
				expect.any(Error),
			)
		})

		it("uses first decisive classifier when multiple conflict", () => {
			const denyClassifier: ClassifierStrategy = {
				name: "deny-first",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "denied", confidence: 0.9 }),
			}
			const allowClassifier: ClassifierStrategy = {
				name: "allow-second",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "allow", reason: "allowed", confidence: 0.9 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(denyClassifier)
			engine.registerClassifier(allowClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["deny-first", "allow-second"] })

			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("deny")
		})

		it("skips low-confidence result and falls through to next classifier", () => {
			const lowConf: ClassifierStrategy = {
				name: "low-conf",
				confidence: "low",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "unsure", confidence: 0.3 }),
			}
			const highConf: ClassifierStrategy = {
				name: "high-conf",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "ask", reason: "certain", confidence: 0.9 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(lowConf)
			engine.registerClassifier(highConf)
			engine.setClassifierConfig({
				enabledClassifiers: ["low-conf", "high-conf"],
				minConfidenceThreshold: 0.5,
			})

			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
		})

		it("skips classifier with no classifySync in sync path", () => {
			const asyncOnly: ClassifierStrategy = {
				name: "async-only",
				confidence: "high",
				classify: vi.fn().mockResolvedValue({ action: "deny", reason: "async", confidence: 1 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(asyncOnly)
			engine.setClassifierConfig({ enabledClassifiers: ["async-only"] })

			// Falls through to default (no sync result available)
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
			expect(logger.warn).toHaveBeenCalledWith("PermissionRuleEngine", expect.stringContaining("async-only"))
		})

		it("skips classifiers not in enabledClassifiers list", () => {
			const classifier: ClassifierStrategy = {
				name: "disabled-clf",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "should not run", confidence: 1 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(classifier)
			// enabledClassifiers is empty from engineWithoutClassifiers()

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})

		it("accepts result at exact confidence threshold boundary", () => {
			const classifier: ClassifierStrategy = {
				name: "boundary",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "exact", confidence: 0.5 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["boundary"], minConfidenceThreshold: 0.5 })

			// confidence 0.5 >= threshold 0.5 → accepted
			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("deny")
		})

		it("rejects result just below confidence threshold", () => {
			const classifier: ClassifierStrategy = {
				name: "below",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "deny", reason: "close", confidence: 0.49 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(classifier)
			engine.setClassifierConfig({ enabledClassifiers: ["below"], minConfidenceThreshold: 0.5 })

			// confidence 0.49 < threshold 0.5 → ignored, falls to default (readOnly → allow)
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
		})

		it("returns ask from sync classifier when action is ask", () => {
			const askClassifier: ClassifierStrategy = {
				name: "ask-sync",
				confidence: "high",
				classify: vi.fn(),
				classifySync: () => ({ action: "ask", reason: "please confirm", confidence: 0.8 }),
			}
			const engine = engineWithoutClassifiers()
			engine.registerClassifier(askClassifier)
			engine.setClassifierConfig({ enabledClassifiers: ["ask-sync"] })

			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
		})
	})

	// ── 4. Rule management ─────────────────────────────────────────

	describe("rule management", () => {
		it("sorts rules by source priority: policy > policySettings > project > user > session", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "session", source: "session", priority: 999 }))
			engine.addRule(rule({ id: "user", source: "user", priority: 1 }))
			engine.addRule(rule({ id: "project", source: "project", priority: 1 }))
			engine.addRule(rule({ id: "policySettings", source: "policySettings", priority: 1 }))
			engine.addRule(rule({ id: "policy", source: "policy", priority: 1 }))

			const ids = engine.getRules().map((r) => r.id)
			expect(ids).toEqual(["policy", "policySettings", "project", "user", "session"])
		})

		it("sorts rules within same source by rule priority descending", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "low", source: "user", priority: 1 }))
			engine.addRule(rule({ id: "high", source: "user", priority: 100 }))
			engine.addRule(rule({ id: "mid", source: "user", priority: 50 }))

			expect(engine.getRules().map((r) => r.id)).toEqual(["high", "mid", "low"])
		})

		it("treats rules without source as session priority", () => {
			const engine = engineWithoutClassifiers()
			const noSourceRule: PermissionRule = {
				id: "no-src",
				description: "no source",
				action: "allow",
				toolPattern: "*",
				priority: 999,
			}
			engine.addRule(noSourceRule)
			engine.addRule(rule({ id: "user-low", source: "user", priority: 1 }))

			// user (100) > session (0, default for missing source)
			expect(engine.getRules().map((r) => r.id)).toEqual(["user-low", "no-src"])
		})

		it("removeRule only removes the matching ID", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "r1", action: "allow", toolPattern: "read_file" }))
			engine.addRule(rule({ id: "r2", action: "deny", toolPattern: "write_file" }))
			engine.addRule(rule({ id: "r3", action: "ask", toolPattern: "delete_file" }))

			engine.removeRule("r2")

			expect(engine.getRules().map((r) => r.id)).toEqual(["r1", "r3"])
		})

		it("removeRule with non-existent ID leaves rules unchanged", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "r1", action: "allow", toolPattern: "*" }))

			engine.removeRule("non-existent")

			expect(engine.getRules()).toHaveLength(1)
		})

		it("getRules reflects current rules accurately", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.getRules()).toHaveLength(0)

			engine.addRule(rule({ id: "r1", action: "allow", toolPattern: "read_*" }))
			expect(engine.getRules()).toHaveLength(1)
			expect(engine.getRules()[0].id).toBe("r1")

			engine.addRule(rule({ id: "r2", action: "deny", toolPattern: "write_*" }))
			expect(engine.getRules()).toHaveLength(2)

			engine.removeRule("r1")
			expect(engine.getRules()).toHaveLength(1)
			expect(engine.getRules()[0].id).toBe("r2")
		})
	})

	// ── 5. Mode switching ──────────────────────────────────────────

	describe("mode switching", () => {
		it("defaults to 'default' mode", () => {
			const engine = new PermissionRuleEngine()
			expect(engine.getMode()).toBe("default")
		})

		it("setMode and getMode work correctly", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")
			expect(engine.getMode()).toBe("bypass")
			engine.setMode("ask")
			expect(engine.getMode()).toBe("ask")
			engine.setMode("auto")
			expect(engine.getMode()).toBe("auto")
			engine.setMode("default")
			expect(engine.getMode()).toBe("default")
		})

		it("mode persists across multiple evaluations", () => {
			const engine = engineWithoutClassifiers()
			engine.setMode("ask")

			expect(engine.evaluate("read_file", {}, readOnly)).toBe("ask")
			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
			expect(engine.evaluate("apply_diff", {}, destructive)).toBe("ask")
		})

		it("changing mode mid-session changes behavior immediately", () => {
			const engine = engineWithoutClassifiers()

			engine.setMode("default")
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")

			engine.setMode("ask")
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("ask")

			engine.setMode("auto")
			expect(engine.evaluate("read_file", {}, readOnly)).toBe("allow")
			expect(engine.evaluate("write_to_file", {}, writeTool)).toBe("ask")
		})

		it("bypass mode still runs classifiers and denies dangerous commands", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			// StaticPatternClassifier flags "rm -rf /"
			expect(engine.evaluate("execute_command", { command: "rm -rf /" }, destructive)).toBe("deny")
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_deny", expect.any(Object))
		})

		it("bypass mode records allow metric for safe tools", () => {
			const engine = new PermissionRuleEngine()
			engine.setMode("bypass")

			engine.evaluate("read_file", { path: "a.ts" }, readOnly)
			expect(recordSecurityMetric).toHaveBeenCalledWith("permission_bypass_allow", expect.any(Object))
		})
	})

	// ── 6. Denial tracking ─────────────────────────────────────────

	describe("denial tracking", () => {
		it("returns 0 for unknown tool", () => {
			const engine = engineWithoutClassifiers()
			expect(engine.getDenialCount("never_denied")).toBe(0)
		})

		it("increments count on each recordDenial call", () => {
			const engine = engineWithoutClassifiers()
			engine.recordDenial("tool_a")
			expect(engine.getDenialCount("tool_a")).toBe(1)
			engine.recordDenial("tool_a")
			expect(engine.getDenialCount("tool_a")).toBe(2)
			engine.recordDenial("tool_a")
			expect(engine.getDenialCount("tool_a")).toBe(3)
		})

		it("tracks denials independently per tool", () => {
			const engine = engineWithoutClassifiers()
			engine.recordDenial("tool_a")
			engine.recordDenial("tool_a")
			engine.recordDenial("tool_b")

			expect(engine.getDenialCount("tool_a")).toBe(2)
			expect(engine.getDenialCount("tool_b")).toBe(1)
		})

		it("resetDenials clears count for specific tool only", () => {
			const engine = engineWithoutClassifiers()
			engine.recordDenial("tool_a")
			engine.recordDenial("tool_b")

			engine.resetDenials("tool_a")

			expect(engine.getDenialCount("tool_a")).toBe(0)
			expect(engine.getDenialCount("tool_b")).toBe(1)
		})

		it("resetDenials on non-existent tool does not throw", () => {
			const engine = engineWithoutClassifiers()
			expect(() => engine.resetDenials("nonexistent")).not.toThrow()
		})

		it("auto-expires denial count after 10 minutes", () => {
			vi.useFakeTimers()
			const engine = engineWithoutClassifiers()

			engine.recordDenial("tool")
			engine.recordDenial("tool")
			expect(engine.getDenialCount("tool")).toBe(2)

			vi.advanceTimersByTime(10 * 60 * 1000) // exactly 10 minutes
			expect(engine.getDenialCount("tool")).toBe(0)

			vi.useRealTimers()
		})

		it("resets window when denial is re-recorded before expiry", () => {
			vi.useFakeTimers()
			const engine = engineWithoutClassifiers()

			engine.recordDenial("tool")
			vi.advanceTimersByTime(5 * 60 * 1000) // 5 min (within window)
			engine.recordDenial("tool") // resets the window
			expect(engine.getDenialCount("tool")).toBe(2)

			vi.advanceTimersByTime(5 * 60 * 1000) // 10 min from first, but only 5 from second
			expect(engine.getDenialCount("tool")).toBe(2) // still valid

			vi.advanceTimersByTime(5 * 60 * 1000) // now 10 min from second denial
			expect(engine.getDenialCount("tool")).toBe(0) // expired

			vi.useRealTimers()
		})

		it("starts fresh count when re-denied after expiry", () => {
			vi.useFakeTimers()
			const engine = engineWithoutClassifiers()

			engine.recordDenial("tool")
			engine.recordDenial("tool")
			engine.recordDenial("tool")

			vi.advanceTimersByTime(10 * 60 * 1000)
			expect(engine.getDenialCount("tool")).toBe(0)

			engine.recordDenial("tool")
			expect(engine.getDenialCount("tool")).toBe(1) // fresh start

			vi.useRealTimers()
		})

		it("auto-downgrade triggers at exact threshold", () => {
			const engine = engineWithoutClassifiers()
			engine.setClassifierConfig({ autoDowngradeAfterDenials: 3 })

			engine.recordDenial("tool")
			engine.recordDenial("tool")
			// 2 denials < threshold 3: no downgrade, default for readOnly is allow
			expect(engine.evaluate("tool", {}, readOnly)).toBe("allow")

			engine.recordDenial("tool")
			// 3 denials >= threshold 3: downgrade to ask
			expect(engine.evaluate("tool", {}, readOnly)).toBe("ask")
		})

		it("auto-downgrade disabled when threshold is 0", () => {
			const engine = engineWithoutClassifiers()
			engine.setClassifierConfig({ autoDowngradeAfterDenials: 0 })

			for (let i = 0; i < 20; i++) {
				engine.recordDenial("tool")
			}

			// Even with 20 denials, no downgrade; readOnly → allow
			expect(engine.evaluate("tool", {}, readOnly)).toBe("allow")
		})

		it("denial recorded by evaluate when deny rule matches", () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(rule({ id: "deny-write", action: "deny", toolPattern: "write_to_file" }))

			engine.evaluate("write_to_file", {}, writeTool)
			expect(engine.getDenialCount("write_to_file")).toBe(1)

			engine.evaluate("write_to_file", {}, writeTool)
			expect(engine.getDenialCount("write_to_file")).toBe(2)
		})
	})

	// ── 7. Config persistence ──────────────────────────────────────

	describe("config persistence", () => {
		it("loads rules from valid JSON config", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce(
				JSON.stringify({
					rules: [
						{
							id: "r1",
							description: "Rule 1",
							action: "allow",
							toolPattern: "read_*",
							priority: 10,
							source: "user",
						},
						{
							id: "r2",
							description: "Rule 2",
							action: "deny",
							toolPattern: "write_*",
							priority: 5,
							source: "policy",
						},
					],
				}),
			)

			const engine = engineWithoutClassifiers()
			await engine.loadFromConfig("config.json")

			const rules = engine.getRules()
			expect(rules).toHaveLength(2)
			// policy (200) sorts before user (100)
			expect(rules[0].id).toBe("r2")
			expect(rules[1].id).toBe("r1")
		})

		it("throws on invalid JSON (graceful failure via JSON.parse)", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce("this is not valid json {{{")

			const engine = engineWithoutClassifiers()
			await expect(engine.loadFromConfig("bad.json")).rejects.toThrow()
		})

		it("throws when config has rules as non-array", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ rules: "not-an-array" }))

			const engine = engineWithoutClassifiers()
			await expect(engine.loadFromConfig("bad.json")).rejects.toThrow("Invalid permission config")
		})

		it("throws when config is empty object", async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce("{}")

			const engine = engineWithoutClassifiers()
			await expect(engine.loadFromConfig("empty.json")).rejects.toThrow("Invalid permission config")
		})

		it("saveToConfig serializes rules as valid JSON without condition functions", async () => {
			const engine = engineWithoutClassifiers()
			engine.addRule(
				rule({
					id: "r1",
					action: "allow",
					toolPattern: "read_*",
					priority: 10,
					source: "user",
					condition: () => true, // should not appear in output
				}),
			)

			await engine.saveToConfig("output.json")

			expect(fs.writeFile).toHaveBeenCalledOnce()
			const [, content] = vi.mocked(fs.writeFile).mock.calls[0]!
			const parsed = JSON.parse(content as string)
			expect(parsed.rules).toHaveLength(1)
			expect(parsed.rules[0].id).toBe("r1")
			expect(parsed.rules[0]).not.toHaveProperty("condition")
			expect(parsed.rules[0].source).toBe("user")
		})

		it("roundtrip: save then load produces identical rules", async () => {
			const engine1 = engineWithoutClassifiers()
			engine1.addRule(rule({ id: "r1", action: "allow", toolPattern: "read_*", priority: 10, source: "user" }))
			engine1.addRule(rule({ id: "r2", action: "deny", toolPattern: "write_*", priority: 5, source: "policy" }))

			await engine1.saveToConfig("roundtrip.json")

			const [, content] = vi.mocked(fs.writeFile).mock.calls[0]!
			vi.mocked(fs.readFile).mockResolvedValueOnce(content as string)

			const engine2 = engineWithoutClassifiers()
			await engine2.loadFromConfig("roundtrip.json")

			expect(engine2.getRules().map((r) => r.id)).toEqual(engine1.getRules().map((r) => r.id))
			expect(
				engine2.getRules().map((r) => ({ action: r.action, toolPattern: r.toolPattern, source: r.source })),
			).toEqual(
				engine1.getRules().map((r) => ({ action: r.action, toolPattern: r.toolPattern, source: r.source })),
			)
		})
	})

	// ── 8. Classifier management ───────────────────────────────────

	describe("classifier management", () => {
		it("constructor registers StaticPatternClassifier by default", () => {
			const engine = new PermissionRuleEngine()
			expect(engine.getClassifierNames()).toContain("static-pattern")
		})

		it("registerClassifier prevents duplicate names", () => {
			const engine = new PermissionRuleEngine()
			const clf: ClassifierStrategy = {
				name: "custom",
				confidence: "high",
				classify: vi.fn(),
			}
			engine.registerClassifier(clf)
			engine.registerClassifier(clf)

			expect(engine.getClassifierNames().filter((n) => n === "custom")).toHaveLength(1)
		})

		it("unregisterClassifier removes by name", () => {
			const engine = new PermissionRuleEngine()
			const clf: ClassifierStrategy = {
				name: "removable",
				confidence: "high",
				classify: vi.fn(),
			}
			engine.registerClassifier(clf)
			expect(engine.getClassifierNames()).toContain("removable")

			engine.unregisterClassifier("removable")
			expect(engine.getClassifierNames()).not.toContain("removable")
		})

		it("setClassifierConfig merges partial config", () => {
			const engine = new PermissionRuleEngine()
			const original = engine.getClassifierConfig()

			engine.setClassifierConfig({ minConfidenceThreshold: 0.9 })

			expect(engine.getClassifierConfig().minConfidenceThreshold).toBe(0.9)
			// Other fields preserved
			expect(engine.getClassifierConfig().enabledClassifiers).toEqual(original.enabledClassifiers)
		})

		it("getClassifierConfig returns current config", () => {
			const engine = new PermissionRuleEngine()
			const config: Partial<ClassifierChainConfig> = {
				enabledClassifiers: ["a", "b"],
				minConfidenceThreshold: 0.7,
				autoDowngradeAfterDenials: 10,
			}
			engine.setClassifierConfig(config)

			const result = engine.getClassifierConfig()
			expect(result.enabledClassifiers).toEqual(["a", "b"])
			expect(result.minConfidenceThreshold).toBe(0.7)
			expect(result.autoDowngradeAfterDenials).toBe(10)
		})
	})
})
