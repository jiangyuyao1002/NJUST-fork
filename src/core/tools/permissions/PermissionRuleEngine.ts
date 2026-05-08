import * as fs from "fs/promises"
import { PermissionRule, PermissionAction, PermissionSource, SOURCE_PRIORITY } from "./PermissionRule"
import { recordSecurityMetric } from "../../security/metrics"
import { BashCommandAnalyzer, StaticPatternClassifier, type RiskLevel } from "./BashCommandAnalyzer"
import { logger } from "../../../shared/logger"
import type { ClassifierStrategy, ClassifierContext, ClassifyResult, ClassifierChainConfig } from "./ClassifierStrategy"

function summarizeParamsForAudit(toolName: string, params: Record<string, unknown>): string {
	try {
		const s = JSON.stringify(params)
		const body = s.length > 500 ? s.slice(0, 500) + "…" : s
		return `${toolName}: ${body}`
	} catch {
		return `${toolName}: [unserializable params]`
	}
}

/**
 * Permission mode controls top-level behavior before rule evaluation.
 *
 * - "default": current behavior — rules are evaluated normally
 * - "auto":    read-only tools auto-allowed, write tools need confirmation
 * - "bypass":  all tools auto-allowed (dangerous, requires explicit opt-in)
 * - "ask":     all tools need confirmation regardless of rules
 */
export type PermissionMode = "default" | "auto" | "bypass" | "ask"

/**
 * Metadata about the tool being evaluated, provided by BaseTool.
 */
export interface ToolMetadata {
	isReadOnly: boolean
	isDestructive: boolean
}

/**
 * Serializable rule format for persistence (no condition functions).
 */
interface SerializedRule {
	id: string
	description: string
	action: PermissionAction
	toolPattern: string
	priority: number
	source?: PermissionSource
}

/**
 * Denial tracking entry for auto-downgrade mechanism.
 */
interface DenialRecord {
	consecutiveCount: number
	lastDenialAt: number
}

/**
 * Match a tool name against a glob-like pattern.
 * Supports:
 *  - "*" matches everything
 *  - "prefix_*" matches any tool starting with "prefix_"
 *  - "*_suffix" matches any tool ending with "_suffix"
 *  - Exact match otherwise
 */
function matchToolPattern(pattern: string, toolName: string): boolean {
	if (pattern === "*") {
		return true
	}
	if (pattern.includes("*")) {
		// Convert simple glob to regex: escape dots, replace * with .*
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
		return new RegExp(`^${escaped}$`).test(toolName)
	}
	return pattern === toolName
}

/**
 * Permission rule engine with pluggable classifier chain support.
 *
 * Evaluates a sorted list of permission rules against a tool invocation
 * and returns the appropriate action (allow / deny / ask).
 *
 * Evaluation pipeline:
 *  1. Mode short-circuit (bypass/ask/auto)
 *  2. Rule evaluation (deny > allow > ask)
 *  3. Classifier chain (pluggable classifiers, e.g., StaticPatternClassifier)
 *  4. Default behavior based on tool metadata
 *
 * Features:
 *  - Pluggable classifier chain (default: StaticPatternClassifier only)
 *  - Denial tracking with auto-downgrade (configurable threshold)
 *  - Extended rule sources (policySettings for organization-level policies)
 */
/**
 * Tools that always require user confirmation even in bypass mode.
 * These can cause irreversible damage to the workspace or system.
 */
const BYPASS_HARDENED_TOOLS = new Set([
	"execute_command",
	"write_to_file",
	"apply_diff",
	"delete_file",
	"insert_content",
	"search_and_replace",
])

export class PermissionRuleEngine {
	private rules: PermissionRule[] = []
	private mode: PermissionMode = "default"

	// ── Classifier chain ─────────────────────────────────────────────
	private classifiers: ClassifierStrategy[] = []
	private classifierConfig: ClassifierChainConfig = {
		enabledClassifiers: ["static-pattern"],
		minConfidenceThreshold: 0.5,
		autoDowngradeAfterDenials: 5,
	}

	// ── Denial tracking ──────────────────────────────────────────────
	private denialTracker: Map<string, DenialRecord> = new Map()
	/** Reset window: denial counts reset after 10 minutes of no denials. */
	private static readonly DENIAL_RESET_MS = 10 * 60 * 1000

	constructor() {
		// Register the default static pattern classifier
		this.classifiers.push(new StaticPatternClassifier())
	}

	// ── Mode management ──────────────────────────────────────────────

	/**
	 * TODO: When agent system permissionMode is wired to runtime,
	 * move bypassWarningActive calculation from ClineProvider to here.
	 * The current implementation is in ClineProvider.getStateToPostToWebview().
	 */

	setMode(mode: PermissionMode): void {
		this.mode = mode
	}

	getMode(): PermissionMode {
		return this.mode
	}

	// ── Classifier management ────────────────────────────────────────

	/**
	 * Register a classifier. Classifiers are evaluated in registration order,
	 * filtered by enabledClassifiers config.
	 */
	registerClassifier(classifier: ClassifierStrategy): void {
		// Avoid duplicates
		if (!this.classifiers.some((c) => c.name === classifier.name)) {
			this.classifiers.push(classifier)
		}
	}

	/**
	 * Remove a classifier by name.
	 */
	unregisterClassifier(name: string): void {
		this.classifiers = this.classifiers.filter((c) => c.name !== name)
	}

	/**
	 * Get registered classifier names.
	 */
	getClassifierNames(): string[] {
		return this.classifiers.map((c) => c.name)
	}

	/**
	 * Update classifier chain configuration.
	 */
	setClassifierConfig(config: Partial<ClassifierChainConfig>): void {
		this.classifierConfig = { ...this.classifierConfig, ...config }
	}

	/**
	 * Get current classifier chain configuration.
	 */
	getClassifierConfig(): Readonly<ClassifierChainConfig> {
		return this.classifierConfig
	}

	// ── Denial tracking ──────────────────────────────────────────────

	/**
	 * Record a denial for a tool. Used by BaseTool after permission is denied.
	 */
	recordDenial(toolName: string): void {
		const now = Date.now()
		const existing = this.denialTracker.get(toolName)
		if (existing && (now - existing.lastDenialAt) < PermissionRuleEngine.DENIAL_RESET_MS) {
			existing.consecutiveCount++
			existing.lastDenialAt = now
		} else {
			this.denialTracker.set(toolName, { consecutiveCount: 1, lastDenialAt: now })
		}
	}

	/**
	 * Reset denial count for a tool. Called when a tool is successfully approved.
	 */
	resetDenials(toolName: string): void {
		this.denialTracker.delete(toolName)
	}

	/**
	 * Get the current consecutive denial count for a tool.
	 */
	getDenialCount(toolName: string): number {
		const record = this.denialTracker.get(toolName)
		if (!record) return 0
		// Auto-reset if enough time has passed
		if ((Date.now() - record.lastDenialAt) >= PermissionRuleEngine.DENIAL_RESET_MS) {
			this.denialTracker.delete(toolName)
			return 0
		}
		return record.consecutiveCount
	}

	// ── Rule management ──────────────────────────────────────────────

	/**
	 * Sort rules by source priority (descending) then by rule priority (descending).
	 */
	private sortRules(): void {
		this.rules.sort((a, b) => {
			const aSrc = SOURCE_PRIORITY[a.source ?? "session"]
			const bSrc = SOURCE_PRIORITY[b.source ?? "session"]
			if (aSrc !== bSrc) {
				return bSrc - aSrc
			}
			return b.priority - a.priority
		})
	}

	addRule(rule: PermissionRule): void {
		this.rules.push(rule)
		this.sortRules()
	}

	removeRule(ruleId: string): void {
		this.rules = this.rules.filter((r) => r.id !== ruleId)
	}

	getRules(): ReadonlyArray<PermissionRule> {
		return this.rules
	}

	// ── Core evaluation ──────────────────────────────────────────────

	/**
	 * Evaluate rules and classifiers for a tool invocation.
	 *
	 * Pipeline:
	 *  1. Mode short-circuit
	 *  2. Rule evaluation (deny > allow > ask)
	 *  3. Classifier chain (after rules, before defaults)
	 *  4. Denial auto-downgrade check
	 *  5. Default behavior based on tool metadata
	 */
	evaluate(toolName: string, params: Record<string, unknown>, toolMeta: ToolMetadata): PermissionAction {
		// Mode short-circuits
		switch (this.mode) {
			case "bypass": {
				const audit = summarizeParamsForAudit(toolName, params)
				if (toolMeta.isDestructive || BYPASS_HARDENED_TOOLS.has(toolName)) {
					logger.warn(
						"PermissionRuleEngine",
						`Permission mode is "bypass" but tool=${toolName} is hardened: requiring confirmation. params=${audit}`,
					)
					recordSecurityMetric("permission_bypass_hardened_ask", { tool: toolName, paramSummary: audit })
					return "ask"
				}
				logger.warn(
					"PermissionRuleEngine",
					`Permission mode is "bypass": auto-allowing tool=${toolName} (all permission checks skipped). params=${audit}`,
				)
				recordSecurityMetric("permission_bypass_allow", { tool: toolName, paramSummary: audit })
				return "allow"
			}
			case "ask":
				return "ask"
			case "auto":
				return toolMeta.isReadOnly ? "allow" : "ask"
			case "default":
				// Fall through to rule + classifier evaluation
				break
		}

		// ── Phase 1: Rule evaluation ─────────────────────────────────
		let sawAllow = false
		let sawAsk = false

		for (const rule of this.rules) {
			if (!matchToolPattern(rule.toolPattern, toolName)) {
				continue
			}
			if (rule.condition && !rule.condition(toolName, params)) {
				continue
			}
			if (rule.action === "deny") {
				logger.info("PermissionRuleEngine", `deny tool=${toolName} rule=${rule.id}`)
				recordSecurityMetric("permission_deny", { tool: toolName, rule: rule.id })
				this.recordDenial(toolName)
				return "deny"
			}
			if (rule.action === "allow") {
				sawAllow = true
				continue
			}
			if (rule.action === "ask") {
				sawAsk = true
			}
		}

		if (sawAllow) {
			return "allow"
		}
		if (sawAsk) {
			return "ask"
		}

		// ── Phase 2: Classifier chain ────────────────────────────────
		// Run synchronously-available classifiers (async classifiers are
		// handled via evaluateAsync). StaticPatternClassifier is sync-safe
		// despite its async interface, so we use a blocking pattern here
		// for backward compatibility with the sync evaluate() signature.
		const classifierAction = this.runClassifierChainSync(toolName, params, toolMeta)
		if (classifierAction) {
			if (classifierAction === "deny") {
				this.recordDenial(toolName)
			}
			return classifierAction
		}

		// ── Phase 3: Denial auto-downgrade ───────────────────────────
		const threshold = this.classifierConfig.autoDowngradeAfterDenials ?? 5
		if (threshold > 0) {
			const denials = this.getDenialCount(toolName)
			if (denials >= threshold) {
				logger.warn(
					"PermissionRuleEngine",
					`auto-downgrade tool=${toolName} after ${denials} consecutive denials → ask`,
				)
				recordSecurityMetric("permission_auto_downgrade", { tool: toolName, denials })
				return "ask"
			}
		}

		// ── Phase 4: Default behavior ────────────────────────────────
		if (toolMeta.isReadOnly) {
			return "allow"
		}
		if (toolMeta.isDestructive) {
			return "ask"
		}
		return "ask"
	}

	/**
	 * Async version of evaluate() that supports async classifiers.
	 * Use this when classifier strategies may perform I/O (e.g., ML model inference).
	 */
	async evaluateAsync(
		toolName: string,
		params: Record<string, unknown>,
		toolMeta: ToolMetadata,
		context?: Partial<ClassifierContext>,
	): Promise<PermissionAction> {
		// Mode and rule evaluation (same as sync)
		const syncResult = this.evaluateRulesOnly(toolName, params, toolMeta)
		if (syncResult !== null) {
			return syncResult
		}

		// Run full async classifier chain
		const classifierAction = await this.runClassifierChainAsync(toolName, params, toolMeta, context)
		if (classifierAction) {
			if (classifierAction === "deny") {
				this.recordDenial(toolName)
			}
			return classifierAction
		}

		// Denial auto-downgrade + defaults (same as sync)
		return this.evaluateDefaults(toolName, toolMeta)
	}

	// ── Private helpers ──────────────────────────────────────────────

	/**
	 * Evaluate only mode and rules (shared by sync and async paths).
	 * Returns null if no decisive result was reached.
	 */
	private evaluateRulesOnly(
		toolName: string,
		params: Record<string, unknown>,
		toolMeta: ToolMetadata,
	): PermissionAction | null {
		switch (this.mode) {
			case "bypass": {
				const audit = summarizeParamsForAudit(toolName, params)
				if (toolMeta.isDestructive || BYPASS_HARDENED_TOOLS.has(toolName)) {
					recordSecurityMetric("permission_bypass_hardened_ask", { tool: toolName, paramSummary: audit })
					return "ask"
				}
				recordSecurityMetric("permission_bypass_allow", { tool: toolName, paramSummary: audit })
				return "allow"
			}
			case "ask": return "ask"
			case "auto": return toolMeta.isReadOnly ? "allow" : "ask"
			case "default": break
		}

		let sawAllow = false
		let sawAsk = false

		for (const rule of this.rules) {
			if (!matchToolPattern(rule.toolPattern, toolName)) continue
			if (rule.condition && !rule.condition(toolName, params)) continue
			if (rule.action === "deny") {
				recordSecurityMetric("permission_deny", { tool: toolName, rule: rule.id })
				this.recordDenial(toolName)
				return "deny"
			}
			if (rule.action === "allow") { sawAllow = true; continue }
			if (rule.action === "ask") { sawAsk = true }
		}

		if (sawAllow) return "allow"
		if (sawAsk) return "ask"
		return null
	}

	/**
	 * Evaluate defaults + denial auto-downgrade.
	 */
	private evaluateDefaults(toolName: string, toolMeta: ToolMetadata): PermissionAction {
		const threshold = this.classifierConfig.autoDowngradeAfterDenials ?? 5
		if (threshold > 0 && this.getDenialCount(toolName) >= threshold) {
			return "ask"
		}
		if (toolMeta.isReadOnly) return "allow"
		if (toolMeta.isDestructive) return "ask"
		return "ask"
	}

	/**
	 * Run classifier chain synchronously (for backward-compat with sync evaluate()).
	 * Uses classifier.classifySync when implemented (e.g. StaticPatternClassifier);
	 * async-only classifiers are skipped here — use evaluateAsync() for those.
	 */
	private runClassifierChainSync(
		toolName: string,
		params: Record<string, unknown>,
		toolMeta: ToolMetadata,
	): PermissionAction | null {
		const { enabledClassifiers, minConfidenceThreshold = 0.5 } = this.classifierConfig
		const context: ClassifierContext = {
			toolName,
			isReadOnly: toolMeta.isReadOnly,
			isDestructive: toolMeta.isDestructive,
			consecutiveDenials: this.getDenialCount(toolName),
		}

		for (const classifier of this.classifiers) {
			if (!enabledClassifiers.includes(classifier.name)) continue

			try {
				if (typeof classifier.classifySync !== "function") {
					logger.warn(
						"PermissionRuleEngine",
						`classifier ${classifier.name} has no classifySync — skipped in sync path. Use evaluateAsync().`,
					)
					continue
				}

				const result = classifier.classifySync(toolName, params, context)

				if (result && result.confidence >= minConfidenceThreshold) {
					if (result.action === "deny") {
						logger.info("PermissionRuleEngine", `deny tool=${toolName} classifier=${classifier.name}: ${result.reason}`)
						recordSecurityMetric("permission_deny", {
							tool: toolName,
							classifier: classifier.name,
							confidence: result.confidence,
						})
						return "deny"
					}
					if (result.action === "ask") {
						logger.info("PermissionRuleEngine", `ask tool=${toolName} classifier=${classifier.name}: ${result.reason}`)
						return "ask"
					}
				}
			} catch (err) {
				logger.warn("PermissionRuleEngine", `classifier ${classifier.name} error (ignored):`, err)
			}
		}

		return null
	}

	/**
	 * Run classifier chain asynchronously (for evaluateAsync()).
	 */
	private async runClassifierChainAsync(
		toolName: string,
		params: Record<string, unknown>,
		toolMeta: ToolMetadata,
		extraContext?: Partial<ClassifierContext>,
	): Promise<PermissionAction | null> {
		const { enabledClassifiers, minConfidenceThreshold = 0.5 } = this.classifierConfig
		const context: ClassifierContext = {
			toolName,
			isReadOnly: toolMeta.isReadOnly,
			isDestructive: toolMeta.isDestructive,
			consecutiveDenials: this.getDenialCount(toolName),
			...extraContext,
		}

		for (const classifier of this.classifiers) {
			if (!enabledClassifiers.includes(classifier.name)) continue

			try {
				const result = await classifier.classify(toolName, params, context)

				if (result.confidence >= minConfidenceThreshold) {
					if (result.action === "deny") {
						logger.info("PermissionRuleEngine", `deny tool=${toolName} classifier=${classifier.name}: ${result.reason}`)
						recordSecurityMetric("permission_deny", {
							tool: toolName,
							classifier: classifier.name,
							confidence: result.confidence,
						})
						return "deny"
					}
					if (result.action === "ask") {
						return "ask"
					}
				}
			} catch (err) {
				logger.warn("PermissionRuleEngine", `classifier ${classifier.name} error (ignored):`, err)
			}
		}

		return null
	}

	// ── Config persistence ───────────────────────────────────────────

	async loadFromConfig(configPath: string): Promise<void> {
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content) as { rules?: SerializedRule[] }
		if (!config.rules || !Array.isArray(config.rules)) {
			throw new Error(`Invalid permission config: expected { "rules": [...] } in ${configPath}`)
		}
		this.rules = config.rules.map((sr) => ({
			id: sr.id,
			description: sr.description,
			action: sr.action,
			toolPattern: sr.toolPattern,
			priority: sr.priority,
			source: sr.source,
		}))
		this.sortRules()
	}

	async saveToConfig(configPath: string): Promise<void> {
		const serialized: { rules: SerializedRule[] } = {
			rules: this.rules.map((r) => ({
				id: r.id,
				description: r.description,
				action: r.action,
				toolPattern: r.toolPattern,
				priority: r.priority,
				source: r.source,
			})),
		}
		await fs.writeFile(configPath, JSON.stringify(serialized, null, 2), "utf-8")
	}
}
