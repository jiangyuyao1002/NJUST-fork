import type { ToolName } from "@njust-ai/types"
import type { BaseTool } from "./BaseTool"
import type { ToolRegistry as IToolRegistry } from "./ToolSearchTool"
import { TOOL_ALIASES } from "../../shared/tools"
import { ToolDependencyGraph } from "./ToolDependencyGraph"

type RegisteredTool = BaseTool<ToolName>

/**
 * Entry for a conditionally registered tool.
 * The tool is only available when its condition returns true.
 */
interface ConditionalToolEntry {
	tool: RegisteredTool
	condition: () => boolean
}

/**
 * Central registry for all tool instances.
 *
 * Replaces the implicit registration pattern (scattered singleton imports + manual arrays)
 * with a single authoritative Map-based registry. Supports:
 * - Canonical name lookup
 * - Alias resolution (seeded from TOOL_ALIASES + per-tool aliases)
 * - Concurrency-safe and checkpoint queries
 *
 * Inspired by Claude Code's findToolByName() dynamic lookup pattern.
 */
export class ToolRegistryImpl implements IToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>()
	private readonly aliasMap = new Map<string, string>() // alias -> canonical name
	private readonly conditionalTools: ConditionalToolEntry[] = []

	// Cached query results (invalidated on register)
	private concurrencySafeCache: Set<ToolName> | null = null
	private checkpointCache: Set<ToolName> | null = null
	private dependencyGraphCache: ToolDependencyGraph | null = null

	constructor() {
		// Seed alias map from the shared TOOL_ALIASES constant
		for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
			this.aliasMap.set(alias, canonical)
		}
	}

	/**
	 * Register a tool instance. Automatically indexes the tool's aliases.
	 * Throws if the canonical name is already registered.
	 */
	register(tool: RegisteredTool): void {
		const name = tool.name
		if (this.tools.has(name)) {
			throw new Error(`ToolRegistry: tool '${name}' is already registered`)
		}
		this.tools.set(name, tool)

		// Index per-tool aliases
		for (const alias of tool.aliases) {
			if (!this.aliasMap.has(alias)) {
				this.aliasMap.set(alias, name)
			}
		}

		// Invalidate caches
		this.concurrencySafeCache = null
		this.checkpointCache = null
		this.dependencyGraphCache = null
	}

	/**
	 * Look up a tool by name, resolving aliases to canonical names.
	 */
	get(name: string): RegisteredTool | undefined {
		const tool = this.tools.get(name)
		if (tool) return tool

		// Try alias resolution
		const canonical = this.aliasMap.get(name)
		if (canonical) {
			return this.tools.get(canonical)
		}

		return undefined
	}

	/**
	 * Check if a tool name (or alias) is registered.
	 */
	has(name: string): boolean {
		return this.get(name) !== undefined
	}

	/**
	 * Return all registered tool instances (no duplicates from aliases).
	 * Implements the ToolSearchTool's ToolRegistry interface.
	 */
	getAllTools(): RegisteredTool[] {
		return Array.from(this.tools.values())
	}

	/**
	 * Return the set of tool names that are concurrency-safe (can be executed in parallel).
	 * Result is cached until the next register() call.
	 */
	getConcurrencySafeNames(): Set<ToolName> {
		if (!this.concurrencySafeCache) {
			this.concurrencySafeCache = new Set<ToolName>(
				this.getAllTools()
					.filter((tool) => {
						try {
							return tool.isConcurrencySafe()
						} catch {
							return false
						}
					})
					.map((tool) => tool.name as ToolName),
			)
		}
		return this.concurrencySafeCache
	}

	/**
	 * Return the set of tool names that require a checkpoint save before execution.
	 * Result is cached until the next register() call.
	 */
	getToolsRequiringCheckpoint(): Set<ToolName> {
		if (!this.checkpointCache) {
			this.checkpointCache = new Set<ToolName>(
				this.getAllTools()
					.filter((tool) => tool.requiresCheckpoint)
					.map((tool) => tool.name as ToolName),
			)
		}
		return this.checkpointCache
	}

	/**
	 * Return all tools that are not deferred (included in initial prompt).
	 */
	getNonDeferredTools(): RegisteredTool[] {
		return this.getAllTools().filter((t) => !t.shouldDefer)
	}

	/**
	 * Return all tools that are deferred (only discovered via ToolSearchTool).
	 */
	getDeferredTools(): RegisteredTool[] {
		return this.getAllTools().filter((t) => t.shouldDefer)
	}

	/**
	 * Resolve an alias to its canonical tool name, or return the name unchanged.
	 */
	resolveAlias(name: string): string {
		return this.aliasMap.get(name) ?? name
	}

	// ── Conditional registration ─────────────────────────────────────

	/**
	 * Register a tool that is only available when its condition returns true.
	 * Conditional tools are re-evaluated on each getAvailableTools() call.
	 *
	 * Use for tools that depend on environment variables, feature flags,
	 * or platform checks (e.g., PowerShellTool on Windows only).
	 */
	registerConditional(tool: RegisteredTool, condition: () => boolean): void {
		this.conditionalTools.push({ tool, condition })
		// Index aliases for conditional tools too
		for (const alias of tool.aliases) {
			if (!this.aliasMap.has(alias)) {
				this.aliasMap.set(alias, tool.name)
			}
		}
	}

	/**
	 * Return all currently available tools: always-registered + conditional tools
	 * whose conditions are satisfied.
	 */
	getAvailableTools(): RegisteredTool[] {
		const conditional = this.conditionalTools
			.filter(({ condition }) => {
				try {
					return condition()
				} catch {
					return false
				}
			})
			.map(({ tool }) => tool)
		return [...this.tools.values(), ...conditional]
	}

	// ── Dependency graph ─────────────────────────────────────────────

	/**
	 * Build and cache a ToolDependencyGraph from all registered tools'
	 * `dependsOn` declarations. Invalidated on register().
	 */
	getDependencyGraph(): ToolDependencyGraph {
		if (!this.dependencyGraphCache) {
			const allTools = this.getAllTools()
			this.dependencyGraphCache = ToolDependencyGraph.fromTools(
				allTools.map((t) => ({ name: t.name, dependsOn: t.dependsOn })),
			)
		}
		return this.dependencyGraphCache
	}

	/**
	 * Return the number of registered tools.
	 */
	get size(): number {
		return this.tools.size
	}
}

/**
 * Singleton tool registry instance.
 */
export const toolRegistry = new ToolRegistryImpl()
