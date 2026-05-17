export interface Plan {
	id: string
	title: string
	description: string
	steps: PlanStep[]
	status: PlanStatus
	createdAt: number
	updatedAt: number
	totalSteps: number
	completedSteps: number
}

export type PlanStatus = "draft" | "approved" | "executing" | "paused" | "completed" | "failed" | "cancelled"

export interface PlanStep {
	id: string
	index: number
	description: string
	mode: string
	dependencies: string[]
	status: PlanStepStatus
	result?: string
	error?: string
	startedAt?: number
	completedAt?: number
	taskId?: string
}

export type PlanStepStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped" | "cancelled"

export interface PlanStepResult {
	stepId: string
	status: PlanStepStatus
	result?: string
	error?: string
}

export interface PlanGenerationOptions {
	task: string
	context?: string
	maxSteps?: number
}

export interface PlanExecutionOptions {
	autoApprove?: boolean
	maxParallel?: number
	onStepStart?: (step: PlanStep) => void
	onStepComplete?: (step: PlanStep, result: PlanStepResult) => void
	onPlanUpdate?: (plan: Plan) => void
}

export interface SharedContext {
	id: string
	modifiedFiles: Set<string>
	results: Map<string, string>
	metadata: Map<string, unknown>
}

export interface AgentInfo {
	id: string
	taskId: string
	mode: string
	status: "idle" | "running" | "completed" | "failed"
	description: string
	startedAt: number
	completedAt?: number
}

// ── AgentDefinition: First-class agent abstraction ──

export type AgentSource = "built-in" | "userSettings" | "projectSettings" | "plugin"

export type AgentPermissionMode =
	| "bypassPermissions"
	| "acceptEdits"
	| "auto"
	| "dontAsk"
	| "plan"
	| "default"

export type AgentIsolation = "shared" | "forked" | "worktree"

export interface BaseAgentDefinition {
	/** Unique agent identifier, e.g. "Explore", "my-plugin:custom" */
	agentType: string
	/** Human-readable description */
	description: string
	/** Source of the agent definition */
	source: AgentSource
	/** Tool names available to this agent. ["*"] means all tools. */
	tools: string[]
	/** Tool names explicitly disallowed (takes precedence over tools) */
	disallowedTools?: string[]
	/** Permission handling mode */
	permissionMode?: AgentPermissionMode
	/** User-visible warning when an agent bypasses normal permission checks. */
	permissionWarning?: string
	/** Model to use. "inherit" means use parent's model. */
	model?: string
	/** Maximum number of agentic turns before auto-completion */
	maxTurns?: number
	/** Force the agent to always run as a background task */
	background?: boolean
	/** Context isolation strategy */
	isolation?: AgentIsolation
	/** Whether the agent should always use cache-aware fork */
	cacheAwareFork?: boolean
	/** Skill names to preload at agent start */
	skills?: string[]
	/** MCP server names to load (additive to parent's) */
	mcpServers?: string[]
	/** Memory/context types to include */
	memory?: ("user" | "project" | "local")[]
	/** System prompt template or inline content */
	systemPrompt?: string | ((params: { taskDescription: string; mode: string }) => string)
	/** Hook identifiers to activate */
	hooks?: string[]
	/** Priority for deduplication (higher = wins) */
	priority?: number
}

export interface BuiltInAgentDefinition extends BaseAgentDefinition {
	source: "built-in"
	systemPrompt: string | ((params: { taskDescription: string; mode: string }) => string)
}

export interface CustomAgentDefinition extends BaseAgentDefinition {
	source: "userSettings" | "projectSettings"
	/** File path from which the agent was loaded */
	filePath?: string
}

export interface PluginAgentDefinition extends BaseAgentDefinition {
	source: "plugin"
	/** Plugin identifier */
	pluginId: string
}

export type AgentDefinition =
	| BuiltInAgentDefinition
	| CustomAgentDefinition
	| PluginAgentDefinition

/** Resolve effective tools considering allow-list and deny-list */
export function resolveAgentTools(def: AgentDefinition): string[] {
	if (def.tools.includes("*")) {
		return ["*"]
	}
	const allowed = new Set(def.tools)
	if (def.disallowedTools) {
		for (const t of def.disallowedTools) {
			allowed.delete(t)
		}
	}
	return Array.from(allowed)
}
