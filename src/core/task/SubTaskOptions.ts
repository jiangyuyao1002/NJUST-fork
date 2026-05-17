/**
 * Sub-task configuration for context isolation and specialization.
 * Inspired by Claude Code's Fork mode and specialized sub-agents.
 */

export type SubAgentType =
	| "explore" // Code exploration: read-only tools, focused on search and understanding
	| "implement" // Implementation: full write permissions
	| "verify" // Verification: run tests and checks
	| "custom" // Custom: inherits parent tools

export type IsolationLevel = "shared" | "forked"

export interface SubTaskOptions {
	/** Isolation level for the sub-task context */
	isolationLevel: IsolationLevel
	/** Independent context budget for the sub-task (tokens) */
	contextBudget?: number
	/** Sub-task type determines available tools and prompt */
	agentType: SubAgentType
	/** Override: specific tools available (empty = inherit from type) */
	tools?: string[]
	/** Maximum result size to inject back into parent context */
	maxResultChars?: number
	/**
	 * When true, build fork context for prompt cache sharing (byte-identical
	 * prefix) instead of a text summary. Requires the provider to support
	 * prompt caching to benefit.
	 */
	cacheAwareFork?: boolean
	/** Cache-safe params for prompt cache sharing (required if cacheAwareFork is true) */
	cacheSafeParams?: CacheSafeParams
}

/** Default tool sets per agent type */
export const AGENT_TYPE_TOOLS: Record<SubAgentType, string[]> = {
	explore: ["read_file", "search_files", "list_files", "list_code_definition_names", "codebase_search"],
	implement: ["read_file", "write_to_file", "apply_diff", "execute_command", "search_files"],
	verify: ["read_file", "execute_command", "search_files", "list_files"],
	custom: [], // inherits parent task tools
}

/** Default context budgets per agent type */
export const AGENT_TYPE_CONTEXT_BUDGET: Record<SubAgentType, number> = {
	explore: 32_000,
	implement: 64_000,
	verify: 32_000,
	custom: 64_000,
}

/** Get effective tools for a sub-agent type, with optional overrides */
export function getEffectiveTools(options: SubTaskOptions): string[] {
	if (options.tools && options.tools.length > 0) {
		return options.tools
	}
	return AGENT_TYPE_TOOLS[options.agentType]
}

/** Get effective context budget for a sub-agent type */
export function getEffectiveContextBudget(options: SubTaskOptions): number {
	return options.contextBudget ?? AGENT_TYPE_CONTEXT_BUDGET[options.agentType]
}

/**
 * Cache-safe parameters for prompt cache sharing between parent and forked agent.
 * When all five components are byte-identical between parent and fork, the
 * provider can reuse the cached prompt prefix, dramatically reducing latency
 * and cache_creation tokens.
 *
 * Inspired by Claude Code's CacheSafeParams in forkedAgent.ts.
 */
export interface CacheSafeParams {
	/** Parent's rendered system prompt (not re-rendered, to avoid divergence) */
	systemPrompt: string
	/** Parent's user context (CLAUDE.md etc.) */
	userContext?: string
	/** Parent's tool definitions (exact same ToolUseBlock params) */
	toolDefinitions?: string
	/** Parent's conversation messages up to the fork point */
	forkContextMessages?: Array<{ role: string; content: UnsafeAny }>
}

/** Configuration for forked context generation */
export interface ForkedContextConfig {
	/** Maximum tokens for the parent context summary */
	summaryMaxTokens: number
	/** Maximum number of recent parent messages to consider */
	maxRecentMessages: number
	/** Whether to include file modification info in the summary */
	includeFileChanges: boolean
	/** Whether to include command execution info in the summary */
	includeCommands: boolean
	/** Maximum characters for the result summary injected back into parent */
	maxResultChars: number
}

export interface TaskResult {
	success: boolean
	summary: string
	isolationLevel?: IsolationLevel
	error?: string
}

/** Default configuration for forked context */
export const DEFAULT_FORKED_CONTEXT_CONFIG: ForkedContextConfig = {
	summaryMaxTokens: 10_000,
	maxRecentMessages: 10,
	includeFileChanges: true,
	includeCommands: true,
	maxResultChars: 2000,
}
