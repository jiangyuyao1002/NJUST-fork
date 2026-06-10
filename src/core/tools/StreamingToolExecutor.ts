import type { ToolUse } from "../../shared/tools"
import type { Task } from "../task/Task"
import { ConcurrentToolExecutor } from "./ConcurrentToolExecutor"
import { logger } from "../../shared/logger"
import { toolRegistry } from "./ToolRegistry"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { classifyToolCategory, ToolExecutionScheduler } from "../task/ToolExecutionOrchestrator"
import type { AdaptiveConcurrencyController } from "./AdaptiveConcurrencyController"

export type EagerToolDecision = "eager" | "deferred"

/**
 * Result of a tool execution that was interrupted by max_output_tokens.
 * The partial output is preserved and marked with a truncation notice.
 */
export interface WithheldToolResult {
	toolUseId: string
	toolName: string
	partialOutput: string
	truncated: true
}

/**
 * Manages eager (streaming) tool execution.
 *
 * Delegates execution decisions to individual tools via:
 * - tool.isPartialArgsStable() — whether partial streaming args are stable enough
 * - tool.getEagerExecutionDecision() — whether the tool opts into eager execution
 *
 * Also handles max_output_tokens interruption recovery:
 * - Detects when a tool execution is interrupted due to token limits
 * - Preserves partial output with a truncation marker
 * - Allows the next API turn to continue based on partial results
 */
export class StreamingToolExecutor {
	private readonly executor: ConcurrentToolExecutor
	private withheldResults: WithheldToolResult[] = []

	/**
	 * Shared abort controller for sibling tools. Set before running eager batches.
	 * When one tool in a batch fails (especially bash), all siblings are signaled.
	 */
	private siblingAbortController: AbortController | null = null

	constructor(
		maxConcurrency = 10,
		concurrencyController?: AdaptiveConcurrencyController,
		scheduler?: ToolExecutionScheduler,
	) {
		this.executor = new ConcurrentToolExecutor({ maxConcurrency, concurrencyController, scheduler })
	}

	/** Wire in the sibling abort controller for the current batch */
	setSiblingAbortController(controller: AbortController): void {
		this.siblingAbortController = controller
	}

	/** Get the current sibling abort signal, or undefined if none */
	getSiblingAbortSignal(): AbortSignal | undefined {
		return this.siblingAbortController?.signal
	}

	/**
	 * Check if a tool's partial streaming arguments have stabilized.
	 * Delegates to the tool's own isPartialArgsStable() method via the registry.
	 */
	private isPartialArgsStable(toolUse: ToolUse): boolean {
		if (!toolUse.partial) {
			return true
		}
		const tool = toolRegistry.get(toolUse.name)
		if (!tool) {
			return false
		}
		return tool.isPartialArgsStable((toolUse.nativeArgs ?? {}) as Record<string, UnsafeAny>)
	}

	/**
	 * Determine whether a tool should be eagerly executed during streaming.
	 * Delegates to the tool's own getEagerExecutionDecision() method.
	 */
	shouldEagerExecute(task: Task, toolUse: ToolUse): EagerToolDecision {
		if (task.didRejectTool) return "deferred"
		if (!this.isPartialArgsStable(toolUse)) return "deferred"
		const tool = toolRegistry.get(toolUse.name)
		if (!tool) return "deferred"
		return tool.getEagerExecutionDecision(
			(toolUse.nativeArgs ?? {}) as Parameters<typeof tool.getEagerExecutionDecision>[0],
		)
	}

	async runEagerBatch(
		task: Task,
		batch: ToolUse[],
		runOne: (toolUse: ToolUse, signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		const itemCategories = new Map<number, ReturnType<typeof classifyToolCategory>>()
		batch.forEach((toolUse, index) => {
			itemCategories.set(index, classifyToolCategory(toolUse.name, false))
		})
		// Reset sibling controller for the new batch
		this.siblingAbortController = new AbortController()

		try {
			await this.executor.run(
				batch,
				async (toolUse, _index, ctx) => {
					// Check both the executor's signal and the sibling abort signal
					const siblingAborted = this.siblingAbortController?.signal.aborted
					if (task.abort || task.didRejectTool || ctx.signal.aborted || siblingAborted) return
					try {
						await runOne(toolUse, ctx.signal)
					} catch (err) {
						// Bash failures propagate to sibling tools
						const category = classifyToolCategory(toolUse.name, false)
						if (category === "bash") {
							this.siblingAbortController?.abort("sibling_error")
						}
						throw err
					}
				},
				{ abortStrategy: "continueOnError", itemCategories },
			)
		} catch (err) {
			// Each tool in the batch has already pushed its own result (success or error).
			// Log the aggregate error but don't re-throw — doing so would trigger the
			// serial fallback path and re-execute already-completed tools.
			logger.error("StreamingToolExecutor", "eager batch completed with errors:", err)
			TelemetryService.reportError(
				err instanceof Error ? err : new Error(String(err)),
				TelemetryEventName.UTILITY_ERROR,
			)
		}
	}

	// ── max_output_tokens interruption recovery ──────────────────────

	/**
	 * Detect if an error represents a max_output_tokens interruption.
	 */
	static isMaxOutputTokensError(error: UnsafeAny): boolean {
		if (!error) return false
		const msg = String((error as Record<string, UnsafeAny>)?.message ?? "").toLowerCase()
		const stopReason = String(
			(error as Record<string, UnsafeAny>)?.stop_reason ?? (error as Record<string, UnsafeAny>)?.stopReason ?? "",
		).toLowerCase()

		return /max[_\s-]?output[_\s-]?tokens/.test(msg) || stopReason === "max_tokens" || stopReason === "length"
	}

	/**
	 * Record a withheld (partially completed) tool result.
	 * Called when a tool execution is interrupted by max_output_tokens.
	 *
	 * The partial output is preserved with a truncation marker so the model
	 * can continue from where it left off in the next API turn.
	 */
	recordWithheldResult(toolUseId: string, toolName: string, partialOutput: string): void {
		this.withheldResults.push({
			toolUseId,
			toolName,
			partialOutput: partialOutput + "\n\n[Output truncated due to token limit]",
			truncated: true,
		})
	}

	/**
	 * Get and clear all withheld results.
	 * These should be included in the next API request as partial tool results.
	 */
	drainWithheldResults(): WithheldToolResult[] {
		const results = this.withheldResults
		this.withheldResults = []
		return results
	}

	/**
	 * Whether there are withheld results waiting to be sent.
	 */
	hasWithheldResults(): boolean {
		return this.withheldResults.length > 0
	}
}
