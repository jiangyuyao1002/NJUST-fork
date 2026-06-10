/**
 * Agent Feature Integrations
 *
 * Wires AgentDefinition features (MCP servers, skills, hooks) into
 * the Task lifecycle. These are thin integration shims that connect
 * the new AgentDefinition system to the existing infrastructure.
 *
 * Full activation requires the agent lifecycle to call these at the
 * appropriate points: start → activate, stop → deactivate.
 */

import type { AgentDefinition } from "./types"
import { ToolHookManager } from "../tools/ToolHookManager"
import type { LifecycleHookContext } from "../tools/toolHooks"
import { logger } from "../../shared/logger"

// ── MCP Integration ──

/**
 * Resolve the effective MCP server list for an agent.
 * Built-in and parent servers are additive.
 */
export function resolveAgentMcpServers(agentDef: AgentDefinition, parentServers: string[] = []): string[] {
	const agentServers = agentDef.mcpServers ?? []
	// Deduplicate: agent-specific servers override parent duplicates
	const seen = new Set(agentServers)
	const all = [...agentServers]
	for (const s of parentServers) {
		if (!seen.has(s)) {
			all.push(s)
			seen.add(s)
		}
	}
	return all
}

// ── Skills Integration ──

/**
 * Resolve the effective skill list for an agent.
 */
export function resolveAgentSkills(agentDef: AgentDefinition): string[] {
	return agentDef.skills ?? []
}

// ── System Prompt Integration ──

/**
 * Resolve the system prompt for an agent.
 * Built-in agents use their defined prompt; custom agents use their Markdown body.
 */
export function resolveAgentSystemPrompt(
	agentDef: AgentDefinition,
	params: { taskDescription: string; mode: string },
): string {
	if (typeof agentDef.systemPrompt === "function") {
		return agentDef.systemPrompt(params)
	}
	if (typeof agentDef.systemPrompt === "string" && agentDef.systemPrompt.length > 0) {
		return agentDef.systemPrompt
	}
	// Fallback for agents without explicit prompt
	return `You are a delegated assistant (${agentDef.agentType}) working on a sub-task in ${params.mode} mode.\n\nTask: ${params.taskDescription}`
}

// ── Tool Resolution ──

/**
 * Resolve the effective tool set for an agent, filtering by allow/disallow lists.
 * Returns ["*"] for agents with full access.
 */
export function resolveAgentEffectiveTools(agentDef: AgentDefinition): string[] {
	if (agentDef.tools.includes("*")) {
		return ["*"]
	}
	const allowed = new Set(agentDef.tools)
	if (agentDef.disallowedTools) {
		for (const t of agentDef.disallowedTools) {
			allowed.delete(t)
		}
	}
	return Array.from(allowed)
}

// ── Lifecycle ──

/**
 * Features activated by a specific agent definition.
 */
export interface AgentFeatureState {
	mcpServers: string[]
	skills: string[]
	systemPrompt: string
	effectiveTools: string[]
	hooks: string[]
	/** Registered hook IDs for cleanup */
	hookIds: string[]
}

/**
 * Resolve hook identifiers from an agent definition.
 */
export function resolveAgentHooks(agentDef: AgentDefinition): string[] {
	return agentDef.hooks ?? []
}

/**
 * Activate agent-specific features.
 * Called at agent start. Resolves all feature configurations and fires
 * subagent-start hooks.
 */
export function activateAgentFeatures(
	agentDef: AgentDefinition,
	params: {
		taskDescription: string
		mode: string
		parentMcpServers?: string[]
		parentTaskId?: string
		taskId?: string
	},
): AgentFeatureState {
	const hookNames = resolveAgentHooks(agentDef)

	// Fire SubagentStartHook if any hooks are configured
	if (hookNames.length > 0 && params.parentTaskId) {
		const hookContext: LifecycleHookContext = {
			taskId: params.taskId,
		}
		// Notify via ToolHookManager that a subagent started
		try {
			void ToolHookManager.instance.runSubagentStartHooks(params.parentTaskId, agentDef.agentType, hookContext)
		} catch (error) {
			logger.debug("AgentFeature", "hook start failed", error)
			// Hooks are fire-and-forget
		}
	}

	return {
		mcpServers: resolveAgentMcpServers(agentDef, params.parentMcpServers),
		skills: resolveAgentSkills(agentDef),
		systemPrompt: resolveAgentSystemPrompt(agentDef, params),
		effectiveTools: resolveAgentEffectiveTools(agentDef),
		hooks: hookNames,
		hookIds: [],
	}
}

/**
 * Deactivate agent-specific features.
 * Called at agent completion. Fires subagent-stop hooks and cleans up.
 */
export function deactivateAgentFeatures(
	state: AgentFeatureState,
	params: { success: boolean; parentTaskId?: string; taskId?: string },
): void {
	if (state.hooks.length > 0 && params.parentTaskId) {
		try {
			void ToolHookManager.instance.runSubagentStopHooks(params.parentTaskId, "agent", params.success, {
				taskId: params.taskId,
			})
		} catch (error) {
			logger.debug("AgentFeature", "hook end failed", error)
			// Hooks are fire-and-forget
		}
	}
}
