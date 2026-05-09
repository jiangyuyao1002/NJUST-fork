/**
 * Centralised timing & numeric constants used across the extension.
 *
 * Every value is `as const` so TypeScript treats them as literal types,
 * preventing accidental reassignment and enabling exhaustiveness checks.
 */

export const TIMING = {
	/** Secret cache refresh interval (5 min) – ContextProxy */
	SECRET_REFRESH_INTERVAL_MS: 5 * 60 * 1000,

	/** Reconciliation interval (5 min) – TaskHistoryStore */
	RECONCILE_INTERVAL_MS: 5 * 60 * 1000,

	/** Token-usage emit interval – Task */
	TOKEN_USAGE_EMIT_INTERVAL_MS: 2000,

	/** Index write debounce – TaskHistoryStore */
	INDEX_WRITE_DEBOUNCE_MS: 2000,

	/** MCP config-change debounce – McpHub */
	MCP_CONFIG_CHANGE_DEBOUNCE_MS: 500,

	/** Max exponential back-off for API retries (10 min) – TaskStreamProcessor */
	MAX_EXPONENTIAL_BACKOFF_MS: 600 * 1000,

	/** Minimum CLI timeout (5 min) – ExecuteCommandTool */
	MIN_CLI_TIMEOUT_MS: 300_000,

	/** Default follow-up auto-approve timeout (60 s) – ClineProvider */
	FOLLOWUP_AUTO_APPROVE_TIMEOUT_MS: 60_000,

	/** In-memory model cache TTL (5 min) – modelCache */
	MODEL_CACHE_TTL_S: 5 * 60,

	/** Agent task completion timeout (10 min) – AgentOrchestrator */
	AGENT_TASK_TIMEOUT_MS: 10 * 60 * 1000,
} as const

export const LIMITS = {
	/** Upper bound on in-memory task entries – TaskHistoryStore */
	MAX_CACHED_TASKS: 2000,

	/** Default max diagnostic messages – ClineProvider */
	MAX_DIAGNOSTIC_MESSAGES: 50,

	/** Cangjie L3 context-section cache TTL range (ms) */
	CANGJIE_L3_CACHE_TTL_MIN_MS: 1000,
	CANGJIE_L3_CACHE_TTL_MAX_MS: 120_000,
	CANGJIE_L3_CACHE_TTL_DEFAULT_MS: 12_000,

	/** Context reduction percentage kept on window errors – TaskStreamProcessor */
	FORCED_CONTEXT_REDUCTION_PERCENT: 75,
} as const
