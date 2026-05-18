import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import type { SharedContext, AgentInfo } from "./types"
import { generateParentContextSummary } from "../task/SubTaskContextBuilder"
import { DEFAULT_FORKED_CONTEXT_CONFIG } from "../task/SubTaskOptions"
import type { ForkedContextConfig } from "../task/SubTaskOptions"
import { TIMING } from "../../shared/constants"
import { getErrorMessage } from "../../shared/error-utils"
import type { AgentLogSink, AgentTaskController, AgentTaskLike } from "./AgentTaskController"

type ApiMessage = { role: string; content: UnsafeAny; ts?: number }

interface SubtaskResult {
	agentId: string
	taskId: string
	resultSummary: string
	status: "completed" | "failed"
}

interface ParallelTaskSpec {
	mode: string
	message: string
	dependencies?: string[]
}

interface ParallelTaskResult {
	agentId: string
	taskId: string
	mode: string
	status: "completed" | "failed"
	result?: string
	error?: string
}

type OrchestratorEvents = {
	agentStarted: [agent: AgentInfo]
	agentCompleted: [agent: AgentInfo, result: string]
	agentFailed: [agent: AgentInfo, error: string]
	allCompleted: [results: ParallelTaskResult[]]
}

/**
 * AgentOrchestrator manages parallel task execution, enabling multiple
 * Agent instances to run concurrently while sharing context.
 *
 * It extends the existing single-task ClineProvider model by maintaining
 * a separate pool of background tasks that don't interfere with the
 * main task stack.
 */
export class AgentOrchestrator extends EventEmitter<OrchestratorEvents> {
	private agents: Map<string, AgentInfo> = new Map()
	private sharedContext: SharedContext
	private sharedContextMutex: Promise<void> = Promise.resolve() // Serializes writes to sharedContext
	private activeTasks: Map<string, AgentTaskLike> = new Map()

	constructor(
		private readonly provider: AgentTaskController,
		private readonly outputChannel: AgentLogSink,
	) {
		super()
		this.sharedContext = {
			id: uuidv7(),
			modifiedFiles: new Set(),
			results: new Map(),
			metadata: new Map(),
		}
	}

	/**
	 * Run multiple tasks in parallel, each in its own mode.
	 * Returns when all tasks have completed (or failed).
	 */
	async runParallel(specs: ParallelTaskSpec[]): Promise<ParallelTaskResult[]> {
		this.outputChannel.appendLine(`[AgentOrchestrator] Starting ${specs.length} parallel tasks`)

		// Detect cycles in dependency graph before scheduling
		const cycleNodes = this.detectCycles(specs)
		if (cycleNodes.length > 0) {
			const cycleDescriptions = cycleNodes.join(" -> ")
			throw new Error(
				`Circular dependency detected among agents: ${cycleDescriptions}. ` +
					`Tasks involved in cycles cannot be scheduled.`,
			)
		}

		const independentSpecs = specs.filter((s) => !s.dependencies?.length)
		const dependentSpecs = specs.filter((s) => s.dependencies?.length)

		const independentResults = await this.runBatch(independentSpecs)
		const allResults = [...independentResults]
		const completedIds = new Set(independentResults.filter((r) => r.status === "completed").map((r) => r.agentId))

		// Resolve dependencies level by level (topological order)
		let remainingDeps = [...dependentSpecs]
		while (remainingDeps.length > 0) {
			const readyDependents = remainingDeps.filter((s) => s.dependencies!.every((dep) => completedIds.has(dep)))

			if (readyDependents.length === 0) {
				// Dependencies can never be satisfied (should not happen after cycle check,
				// but handle gracefully for external dependency references)
				for (const spec of remainingDeps) {
					const missingDeps = spec.dependencies!.filter((dep) => !completedIds.has(dep))
					allResults.push({
						agentId: `unresolved-${spec.mode}`,
						taskId: "",
						mode: spec.mode,
						status: "failed",
						error: `Unresolved dependencies: ${missingDeps.join(", ")}`,
					})
				}
				break
			}

			const depResults = await this.runBatch(readyDependents)
			allResults.push(...depResults)
			for (const r of depResults) {
				if (r.status === "completed") {
					completedIds.add(r.agentId)
				}
			}
			remainingDeps = remainingDeps.filter((s) => !readyDependents.includes(s))
		}

		this.emit("allCompleted", allResults)
		this.outputChannel.appendLine(
			`[AgentOrchestrator] All parallel tasks completed. ` +
				`Success: ${allResults.filter((r) => r.status === "completed").length}, ` +
				`Failed: ${allResults.filter((r) => r.status === "failed").length}`,
		)

		return allResults
	}

	/**
	 * Detects cycles in the dependency graph using DFS.
	 * Returns the first cycle path found, or an empty array if the graph is acyclic.
	 */
	private detectCycles(specs: ParallelTaskSpec[]): string[] {
		const specNodes = new Map<string, ParallelTaskSpec>()
		for (const spec of specs) {
			specNodes.set(spec.mode, spec)
		}

		const WHITE = 0,
			_GRAY = 1,
			_BLACK = 2
		const color = new Map<string, number>()
		const parent = new Map<string, string>()

		for (const node of specNodes.keys()) {
			color.set(node, WHITE)
		}

		for (const node of specNodes.keys()) {
			if (color.get(node) === WHITE) {
				const cycle = this.dfsVisit(node, specNodes, color, parent)
				if (cycle.length > 0) return cycle
			}
		}
		return []
	}

	private dfsVisit(
		node: string,
		nodes: Map<string, ParallelTaskSpec>,
		color: Map<string, number>,
		parent: Map<string, string>,
	): string[] {
		color.set(node, 1) // GRAY

		const spec = nodes.get(node)
		if (spec?.dependencies) {
			for (const dep of spec.dependencies) {
				// Skip dependencies that reference agents outside the current spec set
				if (!nodes.has(dep)) continue

				const depColor = color.get(dep)
				if (depColor === 1) {
					// Back edge found — extract the cycle path
					const cycle: string[] = [dep, node]
					let current = node
					while (parent.has(current) && parent.get(current) !== dep) {
						current = parent.get(current)!
						cycle.push(current)
					}
					cycle.push(dep)
					cycle.reverse()
					return cycle
				} else if (depColor === 0) {
					parent.set(dep, node)
					const cycle = this.dfsVisit(dep, nodes, color, parent)
					if (cycle.length > 0) return cycle
				}
			}
		}

		color.set(node, 2) // BLACK
		return []
	}

	private async runBatch(specs: ParallelTaskSpec[]): Promise<ParallelTaskResult[]> {
		const promises = specs.map((spec) => this.runSingleAgent(spec))
		const settled = await Promise.allSettled(promises)

		return settled.map((result, i) => {
			if (result.status === "fulfilled") {
				return result.value
			}
			return {
				agentId: `failed-${i}`,
				taskId: "",
				mode: specs[i]!.mode,
				status: "failed" as const,
				error: result.reason instanceof Error ? result.reason.message : String(result.reason),
			}
		})
	}

	private async runSingleAgent(spec: ParallelTaskSpec): Promise<ParallelTaskResult> {
		const agentId = uuidv7()
		const agent: AgentInfo = {
			id: agentId,
			taskId: "",
			mode: spec.mode,
			status: "running",
			description: spec.message.slice(0, 100),
			startedAt: Date.now(),
		}

		this.agents.set(agentId, agent)
		this.emit("agentStarted", agent)

		try {
			const contextPrefix = this.buildSharedContextPrompt()
			const fullMessage = contextPrefix ? `${contextPrefix}\n\nTask:\n${spec.message}` : spec.message

			await this.provider.handleModeSwitch(spec.mode as UnsafeAny)
			const task = await this.provider.createTask(fullMessage)

			agent.taskId = task.taskId
			this.activeTasks.set(agentId, task)
			let taskResult!: ParallelTaskResult
			try {
				const result = await this.waitForCompletion(task)

				agent.status = "completed"
				agent.completedAt = Date.now()
				this.sharedContext.results.set(agentId, result)

				this.emit("agentCompleted", agent, result)

				taskResult = {
					agentId,
					taskId: task.taskId,
					mode: spec.mode,
					status: "completed",
					result,
				}
			} finally {
				this.activeTasks.delete(agentId)
			}
			return taskResult
		} catch (error) {
			const errorMsg = getErrorMessage(error)
			agent.status = "failed"
			agent.completedAt = Date.now()

			this.emit("agentFailed", agent, errorMsg)

			return {
				agentId,
				taskId: agent.taskId,
				mode: spec.mode,
				status: "failed",
				error: errorMsg,
			}
		}
	}

	private waitForCompletion(task: AgentTaskLike): Promise<string> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("Agent task timed out after 10 minutes"))
			}, TIMING.AGENT_TASK_TIMEOUT_MS)

			const poll = setInterval(() => {
				try {
					const messages = task.clineMessages || []
					const lastMsg = messages[messages.length - 1]

					if (lastMsg?.type === "say" && lastMsg.say === "completion_result") {
						clearInterval(poll)
						clearTimeout(timeout)
						resolve(lastMsg.text || "Completed")
					}

					if (task.didFinishAbortingStream || task.abandoned) {
						clearInterval(poll)
						clearTimeout(timeout)

						const errorMsg = messages.find((m: UnsafeAny) => m.type === "say" && m.say === "error")
						if (errorMsg) {
							reject(new Error(errorMsg.text || "Task failed"))
						} else {
							resolve("Completed (no explicit result)")
						}
					}
				} catch (e) {
					clearInterval(poll)
					clearTimeout(timeout)
					reject(e)
				}
			}, 500)
		})
	}

	private buildSharedContextPrompt(): string {
		const parts: string[] = []

		if (this.sharedContext.modifiedFiles.size > 0) {
			parts.push(`Files modified by other agents:\n${Array.from(this.sharedContext.modifiedFiles).join("\n")}`)
		}

		if (this.sharedContext.results.size > 0) {
			parts.push("Results from other agents:")
			for (const [id, result] of this.sharedContext.results) {
				const agent = this.agents.get(id)
				const label = agent ? `${agent.mode} agent` : id
				parts.push(`- ${label}: ${result.slice(0, 200)}`)
			}
		}

		return parts.length > 0 ? `[Shared Context]\n${parts.join("\n\n")}\n[End Shared Context]` : ""
	}

	// Run an async operation under the shared-context mutex to prevent
	// interleaved writes to Set/Map from parallel agents.
	private withSharedContextLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.sharedContextMutex.then(fn, fn)
		this.sharedContextMutex = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// Public API

	getSharedContext(): SharedContext {
		return this.sharedContext
	}

	addModifiedFile(filePath: string): void {
		this.sharedContext.modifiedFiles.add(filePath)
	}

	getActiveAgents(): AgentInfo[] {
		return Array.from(this.agents.values()).filter((a) => a.status === "running")
	}

	getAllAgents(): AgentInfo[] {
		return Array.from(this.agents.values())
	}

	async cancelAgent(agentId: string): Promise<void> {
		const task = this.activeTasks.get(agentId)
		if (task) {
			await task.abortTask?.()
			this.activeTasks.delete(agentId)
		}

		const agent = this.agents.get(agentId)
		if (agent) {
			agent.status = "failed"
			agent.completedAt = Date.now()
		}
	}

	async cancelAll(): Promise<void> {
		for (const [agentId] of this.activeTasks) {
			await this.cancelAgent(agentId)
		}
	}

	resetContext(): void {
		this.sharedContext = {
			id: uuidv7(),
			modifiedFiles: new Set(),
			results: new Map(),
			metadata: new Map(),
		}
		this.agents.clear()
	}

	// --- Fork Context Methods ---

	/**
	 * Create a forked context for a subtask.
	 * The subtask gets a summarized snapshot of the parent's messages (not a shared reference).
	 * This prevents subtask conversation from polluting the parent context.
	 *
	 * @param parentMessages - The parent task's API conversation history
	 * @param taskDescription - Description of the subtask to be performed
	 * @param config - Optional forked context configuration
	 * @returns A new message array with a context bootstrap message for the subtask
	 */
	forkContextForSubtask(
		parentMessages: ApiMessage[],
		taskDescription: string,
		config?: ForkedContextConfig,
	): ApiMessage[] {
		const effectiveConfig = config ?? DEFAULT_FORKED_CONTEXT_CONFIG

		// Generate a concise summary of parent context (not exceeding summaryMaxTokens)
		const parentSummary = generateParentContextSummary(
			parentMessages,
			effectiveConfig.summaryMaxTokens,
			effectiveConfig,
		)

		// Build a bootstrap message array for the subtask with:
		// 1. A system-like context message with parent summary
		// 2. The actual task description
		const forkedMessages: ApiMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text" as const,
						text: `[Parent Context Summary]\n${parentSummary}\n[End Parent Context Summary]\n\nTask:\n${taskDescription}`,
					},
				],
				ts: Date.now(),
			},
		]

		this.outputChannel.appendLine(
			`[AgentOrchestrator] Forked context for subtask: ${parentMessages.length} parent messages → summary (${parentSummary.length} chars)`,
		)

		return forkedMessages
	}

	/**
	 * Aggregate subtask results back into parent context.
	 * Injects a structured result summary message into the parent's message array.
	 *
	 * @param subtaskResult - The result from the completed subtask
	 * @param parentMessages - The parent task's API conversation history (mutated in place)
	 * @returns The updated parent messages array
	 */
	aggregateSubtaskResult(subtaskResult: SubtaskResult, parentMessages: ApiMessage[]): ApiMessage[] {
		const resultMessage: ApiMessage = {
			role: "user",
			content: [
				{
					type: "text" as const,
					text: `[Subtask Result - ${subtaskResult.taskId}]\nStatus: ${subtaskResult.status}\n${subtaskResult.resultSummary}\n[End Subtask Result]`,
				},
			],
			ts: Date.now(),
		}

		parentMessages.push(resultMessage)

		this.outputChannel.appendLine(
			`[AgentOrchestrator] Aggregated subtask ${subtaskResult.taskId} result (${subtaskResult.status}) into parent context`,
		)

		return parentMessages
	}
}
