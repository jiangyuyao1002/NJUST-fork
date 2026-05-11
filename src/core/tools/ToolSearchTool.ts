import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"

/**
 * Registry of tool instances that ToolSearchTool can search through.
 * Tools with shouldDefer=true are candidates for deferred loading.
 */
export interface ToolRegistry {
	/** Return all registered BaseTool instances */
	getAllTools(): BaseTool<any>[]
}

/**
 * ToolSearchTool — searches deferred tools by keyword and returns their
 * full descriptions so the model can discover and invoke them.
 *
 * This tool itself is NOT deferred (shouldDefer = false) and is always
 * included in the initial system prompt.
 */
class ToolSearchToolImpl extends BaseTool<"tool_search"> {
	readonly name = "tool_search" as const

	private registry: ToolRegistry | undefined

	/**
	 * Inject the tool registry so this tool can enumerate all registered tools.
	 * Called once during system initialisation (e.g. in build-tools or global registration).
	 */
	setToolRegistry(registry: ToolRegistry): void {
		this.registry = registry
	}

	getToolRegistry(): ToolRegistry {
		if (!this.registry) {
			throw new Error("Tool registry is not configured")
		}
		return this.registry
	}

	// ── BaseTool overrides ──────────────────────────────────────────────

	override get shouldDefer(): boolean {
		return false
	}

	override isReadOnly(): boolean {
		return true
	}

	override isConcurrencySafe(): boolean {
		return true
	}

	override userFacingName(): string {
		return "Tool Search"
	}

	// ── Execution ───────────────────────────────────────────────────────

	override execute(
		params: { query: string },
		_task: Task,
		{ pushToolResult }: ToolCallbacks,
	): Promise<void> {
		const { query } = params

		if (!query || query.trim().length === 0) {
			pushToolResult("Error: query parameter is required and cannot be empty.")
			return
		}

		if (!this.registry) {
			pushToolResult("Error: Tool registry is not configured. No tools available to search.")
			return
		}

		const allTools = this.registry.getAllTools()
		const deferredTools = allTools.filter((t) => t.shouldDefer)

		if (deferredTools.length === 0) {
			pushToolResult("No deferred tools are currently registered.")
			return
		}

		const keywords = query
			.toLowerCase()
			.split(/\s+/)
			.filter((k) => k.length > 0)

		const matched = deferredTools.filter((tool) => {
			const searchableText = [
				tool.name,
				tool.userFacingName(),
				tool.searchHint ?? "",
			]
				.join(" ")
				.toLowerCase()

			return keywords.some((kw) => searchableText.includes(kw))
		})

		if (matched.length === 0) {
			pushToolResult(
				`No deferred tools matched the query "${query}". ` +
					`Available deferred tools: ${deferredTools.map((t) => t.userFacingName()).join(", ")}.`,
			)
			return
		}

		// Build a description block for each matched tool
		const descriptions = matched.map((tool) => {
			const lines: string[] = [
				`## ${tool.userFacingName()} (${tool.name})`,
			]

			if (tool.searchHint) {
				lines.push(`Keywords: ${tool.searchHint}`)
			}

			lines.push(`Read-only: ${tool.isReadOnly() ? "yes" : "no"}`)
			lines.push(`Concurrent-safe: ${tool.isConcurrencySafe(undefined as any) ? "yes" : "no"}`)

			return lines.join("\n")
		})

		pushToolResult(
			`Found ${matched.length} deferred tool(s) matching "${query}":\n\n` +
				descriptions.join("\n\n"),
		)
	}
}

export const toolSearchTool = new ToolSearchToolImpl()
