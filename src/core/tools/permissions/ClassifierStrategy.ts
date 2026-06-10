/**
 * ClassifierStrategy — pluggable security classifier interface.
 *
 * Defines the contract for permission classifiers that can be chained
 * in the PermissionRuleEngine. The default implementation is
 * StaticPatternClassifier (wrapping BashCommandAnalyzer), but future
 * classifiers (e.g., ML-based, YOLO-style dynamic) can be plugged in
 * by implementing this interface.
 *
 * Classifiers are evaluated in priority order; the first high-confidence
 * result wins. Lower-confidence results are used as fallback signals.
 */

/**
 * Context provided to classifiers for richer decision-making.
 */
export interface ClassifierContext {
	/** The tool being invoked. */
	toolName: string
	/** Whether the tool is read-only. */
	isReadOnly: boolean
	/** Whether the tool is destructive. */
	isDestructive: boolean
	/** Current working directory of the task. */
	cwd?: string
	/** Task ID for audit trail. */
	taskId?: string
	/** Number of consecutive denials for this tool in the current session. */
	consecutiveDenials?: number
}

/**
 * Result of a classification decision.
 */
export interface ClassifyResult {
	/** The recommended permission action. */
	action: "allow" | "deny" | "ask"
	/** Human-readable explanation of the decision. */
	reason: string
	/** Confidence score from 0 (no confidence) to 1 (certain). */
	confidence: number
	/** Optional metadata for audit/telemetry. */
	metadata?: Record<string, unknown>
}

/**
 * A pluggable classifier that evaluates tool invocations for security risk.
 *
 * Implementations should be stateless and side-effect-free — the
 * PermissionRuleEngine manages state (denial tracking, caching, etc.).
 */
export interface ClassifierStrategy {
	/** Unique name for this classifier (used in logs and config). */
	readonly name: string

	/**
	 * Self-reported confidence level of this classifier.
	 * Used by the engine to order classifiers and weight results:
	 *   - 'high': result is authoritative (e.g., exact pattern match)
	 *   - 'medium': result is a strong signal (e.g., heuristic)
	 *   - 'low': result is advisory only (e.g., statistical model)
	 */
	readonly confidence: "high" | "medium" | "low"

	/**
	 * Classify a tool invocation.
	 *
	 * @param toolName - The canonical tool name being invoked.
	 * @param input - The tool's input parameters.
	 * @param context - Additional context for richer classification.
	 * @returns Classification result with action, reason, and confidence score.
	 */
	classify(toolName: string, input: Record<string, unknown>, context: ClassifierContext): Promise<ClassifyResult>

	/**
	 * Optional synchronous classification for PermissionRuleEngine.evaluate() (sync).
	 * Implement when classify() has no I/O so the engine can use real results without microtask races.
	 */
	classifySync?(toolName: string, input: Record<string, unknown>, context: ClassifierContext): ClassifyResult
}

/**
 * Configuration for the classifier chain in PermissionRuleEngine.
 */
export interface ClassifierChainConfig {
	/** Ordered list of classifier names to evaluate. First match wins. */
	enabledClassifiers: string[]
	/**
	 * Minimum confidence threshold for a classifier result to be accepted.
	 * Results below this threshold are logged but ignored.
	 * Default: 0.5
	 */
	minConfidenceThreshold?: number
	/**
	 * Number of consecutive denials before auto-downgrading to 'ask'.
	 * This prevents a misconfigured classifier from permanently blocking.
	 * Default: 5 (0 = disabled)
	 */
	autoDowngradeAfterDenials?: number
}
