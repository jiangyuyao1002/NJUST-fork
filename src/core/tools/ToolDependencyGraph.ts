/**
 * Directed acyclic graph of tool dependencies.
 *
 * Allows tools to declare that they depend on the successful completion of
 * other tools. Used by ConcurrentToolExecutor's `transitiveAbort` strategy
 * to selectively abort only the dependents of a failed tool, rather than
 * aborting everything (failFast) or nothing (continueOnError).
 *
 * Example: if tool C depends on tool A, and A fails, C is aborted but
 * unrelated tool B continues.
 */
export class ToolDependencyGraph {
	/** from → Set<to>: "from" depends on "to" completing successfully. */
	private readonly dependencies = new Map<string, Set<string>>()
	/** to → Set<from>: "from" depends on "to"; i.e., "to" is depended upon by these tools. */
	private readonly dependents = new Map<string, Set<string>>()

	/**
	 * Declare that `from` depends on `to`.
	 * When `to` fails, `from` should be aborted.
	 */
	addDependency(from: string, to: string): void {
		if (from === to) {
			return // Self-dependency is a no-op
		}
		if (!this.dependencies.has(from)) {
			this.dependencies.set(from, new Set())
		}
		this.dependencies.get(from)!.add(to)

		if (!this.dependents.has(to)) {
			this.dependents.set(to, new Set())
		}
		this.dependents.get(to)!.add(from)
	}

	/**
	 * Get direct dependents of a tool (tools that depend on this one).
	 */
	getDependents(tool: string): ReadonlySet<string> {
		return this.dependents.get(tool) ?? new Set()
	}

	/**
	 * Get direct dependencies of a tool (tools this one depends on).
	 */
	getDependencies(tool: string): ReadonlySet<string> {
		return this.dependencies.get(tool) ?? new Set()
	}

	/**
	 * Recursively get all transitive dependents of a tool.
	 * If A fails and B depends on A and C depends on B, returns {B, C}.
	 */
	getTransitiveDependents(tool: string): Set<string> {
		const result = new Set<string>()
		const queue = [tool]

		while (queue.length > 0) {
			const current = queue.shift()!
			const directDependents = this.dependents.get(current)
			if (directDependents) {
				for (const dep of directDependents) {
					if (!result.has(dep)) {
						result.add(dep)
						queue.push(dep)
					}
				}
			}
		}

		return result
	}

	/**
	 * Check whether the graph has any dependencies registered.
	 */
	isEmpty(): boolean {
		return this.dependencies.size === 0
	}

	/**
	 * Build a dependency graph from tool declarations.
	 * Each tool declares its own `dependsOn` list.
	 */
	static fromTools(tools: Array<{ name: string; dependsOn: readonly string[] }>): ToolDependencyGraph {
		const graph = new ToolDependencyGraph()
		for (const tool of tools) {
			for (const dep of tool.dependsOn) {
				graph.addDependency(tool.name, dep)
			}
		}
		return graph
	}
}
