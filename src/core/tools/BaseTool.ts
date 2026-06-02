import type { ToolName } from "@njust-ai/types"
import { TelemetryEventName } from "@njust-ai/types"
import { type ZodSchema } from "zod"

import { AskIgnoredError } from "../task/AskIgnoredError"
import type { PermissionRuleEngine } from "./permissions/PermissionRuleEngine"
import { Task } from "../task/Task"
import type {
	ToolUse,
	ToolResponse,
	HandleError,
	PushToolResult,
	AskApproval,
	NativeToolArgs,
} from "../../shared/tools"
import { formatResponse } from "../prompts/responses"
import type { ToolProgressStatus } from "@njust-ai/types"
import { getToolResultBudget, truncateToolResult, estimateTokens } from "./toolResultBudget"
import { shouldPersistResult, persistToolResult, formatStoredResultMessage } from "./toolResultStorage"
import { ToolHookManager } from "./ToolHookManager"
import type { ToolHookContext } from "./toolHooks"
import { toolResultCache } from "./helpers/ToolResultCache"
import { recordSecurityMetric, startTraceSpan } from "../security/metrics"
import { RetryableError } from "./errors"
import { DualSchemaAdapter, type JSONSchema } from "./DualSchemaAdapter"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai/telemetry"
import { createToolValidator } from "./toolParamValidator"

// ── Progress data types (Task 4.1) ───────────────────────────────────
/**
 * Typed progress data for specialized tool categories.
 * Tools can emit progress updates with category-specific metadata.
 */
export type ToolProgressData =
	| { type: "bash"; status: string; exitCode?: number; command?: string }
	| { type: "mcp"; status: string; serverName: string; toolName?: string }
	| { type: "web"; status: string; url?: string; statusCode?: number }
	| { type: "agent"; agentName: string; status: string; turnCount?: number }
	| { type: "file"; status: string; path?: string; operation?: "read" | "write" | "delete" }
	| { type: "generic"; status: string }

// ── Observable input for prompt cache protection (Task 6) ────────────
/**
 * Observable input wraps the original tool parameters with derived fields
 * for UI display, hooks, and logging. The original input is never modified,
 * protecting the prompt cache from invalidation.
 */
export interface ObservableInput<T = Record<string, UnsafeAny>> {
	/** The original, unmodified input (same reference). */
	readonly original: T
	/** Derived/computed fields for observers (UI, hooks, logs). */
	readonly derived: Record<string, UnsafeAny>
}

/**
 * Result of input validation before tool execution.
 */
export interface ValidationResult {
	valid: boolean
	/** Human-readable error description sent back to the LLM. */
	error?: string
}

/**
 * Callbacks passed to tool execution
 */
export interface ToolCallbacks {
	askApproval: AskApproval
	handleError: HandleError
	pushToolResult: PushToolResult
	reportProgress?: (status: ToolProgressStatus) => Promise<void>
	toolCallId?: string
	/**
	 * When set (e.g. parallel eager batch), tools should abort promptly if signal is aborted
	 * (sibling failure or batch cancellation).
	 */
	abortSignal?: AbortSignal
}

/**
 * Helper type to extract the parameter type for a tool based on its name.
 * If the tool has native args defined in NativeToolArgs, use those; otherwise fall back to any.
 */
type ToolParams<TName extends ToolName> = TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : UnsafeAny

/**
 * Abstract base class for all tools.
 *
 * Tools receive typed arguments from native tool calling via `ToolUse.nativeArgs`.
 *
 * @template TName - The specific tool name, which determines native arg types
 */
export abstract class BaseTool<TName extends ToolName> {
	/**
	 * The tool's name (must match ToolName type)
	 */
	abstract readonly name: TName

	/**
	 * Maximum result size in characters. Override in subclasses for tighter limits.
	 * Default: 100KB. Set to Infinity to disable truncation for a specific tool.
	 */
	readonly maxResultSizeChars: number = 100_000

	/**
	 * Whether this tool requires a checkpoint save before execution.
	 * Write/mutating tools should override this to `true`.
	 * Used by ToolRegistry-based dispatch to replace scattered checkpointSaveAndMark calls.
	 */
	readonly requiresCheckpoint: boolean = false

	/**
	 * Track the last seen path during streaming to detect when the path has stabilized.
	 * Used by hasPathStabilized() to prevent displaying truncated paths from partial-json parsing.
	 */
	protected lastSeenPartialPath: string | undefined = undefined

	/**
	 * Optional Zod schema for input validation.
	 * Subclasses can override to define strict input schemas.
	 * When defined, inputs will be validated against this schema before execution.
	 */
	protected get inputSchema(): ZodSchema | undefined {
		return undefined
	}

	/**
	 * Optional explicit JSON Schema for this tool's input.
	 * MCP tools override this to pass the server-provided JSON Schema directly,
	 * bypassing Zod conversion. Native tools leave this undefined and use
	 * the Zod-to-JSON-Schema auto-conversion in DualSchemaAdapter.
	 */
	protected get inputJSONSchema(): JSONSchema | undefined {
		return undefined
	}

	/**
	 * Get a DualSchemaAdapter that provides both Zod and JSON Schema views
	 * of this tool's input schema. Used by MCP tool registration and
	 * prompt generation to obtain the JSON Schema without manual conversion.
	 */
	getSchemaAdapter(): DualSchemaAdapter {
		return new DualSchemaAdapter(this.inputSchema, this.inputJSONSchema)
	}

	/**
	 * Declare tools that this tool depends on.
	 * Used by ToolDependencyGraph for transitiveAbort support.
	 * Override in subclasses to declare dependencies.
	 * Default: no dependencies (empty array).
	 */
	get dependsOn(): readonly string[] {
		return []
	}

	/**
	 * Optional input validation before execution.
	 * Override in subclasses to add specific validation logic.
	 * Default: always valid.
	 *
	 * @deprecated Use validateBusinessLogic() instead. This is kept for backward compatibility.
	 */
	validateInput(_params: ToolParams<TName>): ValidationResult {
		return this.validateBusinessLogic(_params)
	}

	/**
	 * Semantic/business logic validation (e.g., file exists, command not empty).
	 * Called after Zod schema validation passes.
	 * Override in subclasses; default: always valid.
	 */
	validateBusinessLogic(_params: ToolParams<TName>): ValidationResult {
		return { valid: true }
	}

	/**
	 * Preprocess/normalize input parameters before validation and execution.
	 * Called after Zod schema validation but before business logic validation.
	 * Override to normalize paths, trim strings, etc.
	 * Default: identity (returns params unchanged).
	 */
	preprocessInput(params: ToolParams<TName>): ToolParams<TName> {
		return params
	}

	/**
	 * Execute the tool with typed parameters.
	 *
	 * Receives typed parameters from native tool calling via `ToolUse.nativeArgs`
	 * (required at runtime for non-partial blocks; parsers populate this).
	 *
	 * @param params - Typed parameters
	 * @param task - Task instance with state and API access
	 * @param callbacks - Tool execution callbacks (approval, error handling, results)
	 */
	abstract execute(params: ToolParams<TName>, task: Task, callbacks: ToolCallbacks): Promise<void>

	/**
	 * Whether this tool call can be executed concurrently with other tool calls in the same assistant turn.
	 * Phase-B default is false (safe-by-default). Read-only tools should override to true.
	 */
	isConcurrencySafe(_params?: ToolParams<TName>): boolean {
		return false
	}

	/**
	 * Declare whether this tool can be eagerly executed during streaming.
	 * Tools that are safe for eager execution should override to return "eager".
	 * Default: "deferred" (wait until streaming completes).
	 */
	getEagerExecutionDecision(_params: ToolParams<TName>): "eager" | "deferred" {
		return "deferred"
	}

	/**
	 * Check whether partial streaming arguments are stable enough to begin eager execution.
	 * Tools should override this to check their key parameters (e.g., path, pattern).
	 * Default: false (wait for complete args).
	 */
	isPartialArgsStable(_partial: Partial<ToolParams<TName>>): boolean {
		return false
	}

	/**
	 * Whether this tool only reads data without modifying anything.
	 * Used by permission system to auto-approve read-only tools.
	 */
	isReadOnly(_params?: Record<string, UnsafeAny>): boolean {
		return false
	}

	/**
	 * Whether this tool performs destructive operations (delete files, drop tables, etc).
	 * Used by permission system to require explicit user confirmation.
	 */
	isDestructive(_params?: Record<string, UnsafeAny>): boolean {
		return false
	}

	/**
	 * How the tool should behave when the user interrupts execution.
	 * 'cancel' - stop immediately (default)
	 * 'block' - finish current operation before stopping
	 */
	interruptBehavior(): "cancel" | "block" {
		return "cancel"
	}

	/**
	 * User-visible friendly name for this tool.
	 * Defaults to the tool's internal name.
	 */
	userFacingName(): string {
		return this.name
	}

	/**
	 * Keywords for tool search/discovery via ToolSearchTool.
	 * Return undefined if this tool should not be searchable.
	 */
	get searchHint(): string | undefined {
		return undefined
	}

	/**
	 * Alias names for this tool. Models may call the tool by any alias;
	 * the ToolRegistry indexes these automatically during registration.
	 */
	get aliases(): readonly string[] {
		return []
	}

	/**
	 * Whether this tool should be lazily loaded (not included in initial system prompt).
	 * Deferred tools are only loaded when discovered via ToolSearchTool.
	 */
	get shouldDefer(): boolean {
		return false
	}

	/**
	 * Create an observable view of the tool input for UI/hooks/logging.
	 *
	 * The original input is never modified — derived fields are computed
	 * separately. This protects the prompt cache from invalidation when
	 * preprocessInput() would otherwise mutate the cached representation.
	 *
	 * Override in subclasses to add tool-specific derived fields.
	 * Default: returns original input with empty derived fields.
	 *
	 * @param input - The original tool input parameters
	 * @returns ObservableInput with original + derived fields
	 */
	backfillObservableInput(input: ToolParams<TName>): ObservableInput<ToolParams<TName>> {
		return { original: input, derived: {} }
	}

	/**
	 * Handle partial (streaming) tool messages.
	 *
	 * Default implementation does nothing. Tools that support streaming
	 * partial messages should override this.
	 *
	 * @param task - Task instance
	 * @param block - Partial ToolUse block
	 */
	async handlePartial(_task: Task, _block: ToolUse<TName>): Promise<void> {
		// Default: no-op for partial messages
		// Tools can override to show streaming UI updates
	}

	/**
	 * Check if a path parameter has stabilized during streaming.
	 *
	 * During native tool call streaming, the partial-json library may return truncated
	 * string values when chunk boundaries fall mid-value. This method tracks the path
	 * value between consecutive handlePartial() calls and returns true only when the
	 * path has stopped changing (stabilized).
	 *
	 * Usage in handlePartial():
	 * ```typescript
	 * if (!this.hasPathStabilized(block.params.path)) {
	 *     return // Path still changing, wait for it to stabilize
	 * }
	 * // Path is stable, proceed with UI updates
	 * ```
	 *
	 * @param path - The current path value from the partial block
	 * @returns true if path has stabilized (same value seen twice) and is non-empty, false otherwise
	 */
	protected hasPathStabilized(path: string | undefined): boolean {
		const pathHasStabilized = this.lastSeenPartialPath !== undefined && this.lastSeenPartialPath === path
		this.lastSeenPartialPath = path
		return pathHasStabilized && !!path
	}

	/**
	 * Reset the partial state tracking.
	 *
	 * Should be called at the end of execute() (both success and error paths)
	 * to ensure clean state for the next tool invocation.
	 */
	resetPartialState(): void {
		this.lastSeenPartialPath = undefined
	}

	/**
	 * Check permissions using the rule engine.
	 * Falls back to askApproval if no rule engine is configured.
	 * This method can be called by individual tools before executing.
	 *
	 * @param params - Tool parameters
	 * @param callbacks - Tool execution callbacks
	 * @param context - Optional context containing a PermissionRuleEngine
	 * @returns true if the tool is allowed to proceed, false otherwise
	 */
	async checkPermissions(
		params: Record<string, UnsafeAny>,
		callbacks: ToolCallbacks,
		context?: { ruleEngine?: PermissionRuleEngine },
	): Promise<boolean> {
		if (!context?.ruleEngine) {
			return true
		}

		const action = context.ruleEngine.evaluate(this.name, params, {
			isReadOnly: this.isReadOnly(params),
			isDestructive: this.isDestructive(params),
		})

		switch (action) {
			case "allow":
				return true
			case "deny":
				return false
			case "ask":
			default:
				return callbacks.askApproval("tool")
		}
	}

	/**
	 * Main entry point for tool execution.
	 *
	 * Handles the complete flow:
	 * 1. Partial message handling (if partial)
	 * 2. Parameter parsing (nativeArgs only)
	 * 3. Core execution (execute)
	 *
	 * @param task - Task instance
	 * @param block - ToolUse block from assistant message
	 * @param callbacks - Tool execution callbacks
	 */
	async handle(task: Task, block: ToolUse<TName>, callbacks: ToolCallbacks): Promise<void> {
		const toolStartAt = Date.now()
		const memStart = process.memoryUsage()
		const toolSpan = startTraceSpan(
			"tool.handle",
			{
				tool: this.name,
				partial: Boolean(block.partial),
				taskId: task.taskId,
			},
			task.parentTraceId,
		)
		try {
			// Handle partial messages
			if (block.partial) {
				try {
					await this.handlePartial(task, block)
					toolSpan.end("ok", { stage: "partial" })
				} catch (error) {
					if (error instanceof AskIgnoredError) {
						toolSpan.end("ok", { stage: "partial_ignored" })
						return
					}
					logger.error("BaseTool", "Error in handlePartial:", error)
					TelemetryService.reportError(
						error instanceof Error ? error : new Error(String(error)),
						TelemetryEventName.UTILITY_ERROR,
					)
					await callbacks.handleError(
						`handling partial ${this.name}`,
						error instanceof Error ? error : new Error(String(error)),
					)
					toolSpan.end("error", { stage: "partial", error: getErrorMessage(error) })
				}
				return
			}

			// Native-only: obtain typed parameters from `nativeArgs`.
			let params: ToolParams<TName>
			try {
				if (block.nativeArgs !== undefined) {
					// Native: typed args provided by NativeToolCallParser.
					params = block.nativeArgs as ToolParams<TName>
				} else {
					// If legacy/XML markup was provided via params, surface a clear error.
					const paramsText = (() => {
						try {
							return JSON.stringify(block.params ?? {})
						} catch {
							return ""
						}
					})()
					if (paramsText.includes("<") && paramsText.includes(">")) {
						throw new Error(
							"XML tool calls are no longer supported. Use native tool calling (nativeArgs) instead.",
						)
					}
					throw new Error("Tool call is missing native arguments (nativeArgs).")
				}
			} catch (error) {
				logger.error("BaseTool", "Error parsing parameters:", error)
				TelemetryService.reportError(
					error instanceof Error ? error : new Error(String(error)),
					TelemetryEventName.UTILITY_ERROR,
				)
				const errorMessage = `Failed to parse ${this.name} parameters: ${getErrorMessage(error)}`
				await callbacks.handleError(`parsing ${this.name} args`, new Error(errorMessage))
				toolSpan.end("error", { stage: "parse", error: errorMessage })
				// Note: handleError already emits a tool_result via formatResponse.toolError in the caller.
				// Do NOT call pushToolResult here to avoid duplicate tool_result payloads.
				return
			}

			// Validation pipeline: Zod schema → preprocessInput → business logic
			// Step 1: Zod schema validation (structural)
			if (this.inputSchema) {
				const validator = createToolValidator(this.inputSchema)
				const validation = validator.validate(params as Record<string, unknown>)
				if (!validation.valid) {
					callbacks.pushToolResult(
						formatResponse.toolError(
							validation.error || "Invalid tool input. Please check the tool parameters and try again.",
						),
					)
					toolSpan.end("error", { stage: "schema", error: validation.error || "invalid_input" })
					return
				}
			}

			// Step 2: Preprocess/normalize inputs (e.g., path normalization)
			params = this.preprocessInput(params)

			// Step 3: Business logic validation (semantic)
			const validation = this.validateInput(params)
			if (!validation.valid) {
				callbacks.pushToolResult(formatResponse.toolError(validation.error || "Invalid input parameters"))
				toolSpan.end("error", { stage: "validate", error: validation.error || "invalid_input" })
				return
			}

			// Build hook context (needed for both pre-hooks and permission denied hooks)
			const hookManager = ToolHookManager.instance
			const hookContext: ToolHookContext = {
				taskId: task.taskId,
				toolUseId: block.id ?? "",
				cwd: task.cwd,
			}

			// ── Pre-hook execution (configurable order) ──────────────────
			// When hookExecutionOrder === 'before-permission' (default, CC-aligned):
			//   pre-hooks run BEFORE permission checks, allowing hooks to block
			//   or modify input before the permission system sees it.
			// When hookExecutionOrder === 'after-permission' (legacy):
			//   pre-hooks run AFTER permission checks (original behavior).
			if (hookManager.hookExecutionOrder === "before-permission") {
				try {
					const preResult = await hookManager.runPreHooks(
						this.name,
						params as Record<string, UnsafeAny>,
						hookContext,
					)
					if (!preResult.allow) {
						callbacks.pushToolResult(
							formatResponse.toolError(
								`Tool execution blocked by hook${preResult.reason ? `: ${preResult.reason}` : ""}`,
							),
						)
						toolSpan.end("error", { stage: "pre_hook", blocked: true })
						return
					}
					if (preResult.modifiedInput) {
						params = preResult.modifiedInput as ToolParams<TName>
					}
				} catch (hookErr) {
					logger.warn("BaseTool", "Pre-hook error (ignored):", hookErr)
				}
			}

			const permissionContext = {
				ruleEngine: (task as Task & { permissionRuleEngine?: PermissionRuleEngine }).permissionRuleEngine,
			}
			const isAllowed = await this.checkPermissions(
				params as Record<string, UnsafeAny>,
				callbacks,
				permissionContext,
			)
			if (!isAllowed) {
				callbacks.pushToolResult(formatResponse.toolError(`Permission denied for tool '${this.name}'.`))
				toolSpan.end("error", { stage: "permission", denied: true })
				// Run permission denied hooks for audit logging
				try {
					await hookManager.runPermissionDeniedHooks(
						this.name,
						params as Record<string, UnsafeAny>,
						`Permission denied for tool '${this.name}'`,
						hookContext,
					)
				} catch (hookErr) {
					logger.warn("BaseTool", "PermissionDenied hook error (ignored):", hookErr)
				}
				return
			}

			// ── Pre-hook execution (after-permission mode) ───────────────
			if (hookManager.hookExecutionOrder === "after-permission") {
				try {
					const preResult = await hookManager.runPreHooks(
						this.name,
						params as Record<string, UnsafeAny>,
						hookContext,
					)
					if (!preResult.allow) {
						callbacks.pushToolResult(
							formatResponse.toolError(
								`Tool execution blocked by hook${preResult.reason ? `: ${preResult.reason}` : ""}`,
							),
						)
						toolSpan.end("error", { stage: "pre_hook", blocked: true })
						return
					}
					if (preResult.modifiedInput) {
						params = preResult.modifiedInput as ToolParams<TName>
					}
				} catch (hookErr) {
					logger.warn("BaseTool", "Pre-hook error (ignored):", hookErr)
				}
			}

			// Wrap pushToolResult with token budget truncation
			// Some unit tests use minimal task mocks without api/getModel; fall back safely.
			const contextWindow = task.api?.getModel?.()?.info?.contextWindow || 200_000
			const { singleMax } = getToolResultBudget(contextWindow)
			const originalPushToolResult = callbacks.pushToolResult
			const cacheableReadOnly = this.isReadOnly(params as Record<string, UnsafeAny>)
			const cacheKey = cacheableReadOnly ? toolResultCache.makeKey(this.name, params) : undefined
			if (cacheKey) {
				const cached = toolResultCache.get(cacheKey)
				if (cached !== undefined) {
					logger.info("BaseTool", `ToolCache hit tool=${this.name}`)
					recordSecurityMetric("tool_cache_hit", { tool: this.name })
					originalPushToolResult(cached)
					toolSpan.end("ok", { stage: "cache", cacheHit: true })
					return
				}
				logger.info("BaseTool", `ToolCache miss tool=${this.name}`)
				recordSecurityMetric("tool_cache_miss", { tool: this.name })
			}

			if (callbacks.abortSignal?.aborted) {
				callbacks.pushToolResult(
					formatResponse.toolError(
						"Tool execution was cancelled (parallel batch aborted or sibling tool failed).",
					),
					{ isError: true },
				)
				toolSpan.end("error", { stage: "aborted", aborted: true })
				return
			}

			// Capture the last tool result for post-hooks
			let capturedResult: ToolResponse | undefined
			const toolUseId = block.id || callbacks.toolCallId || "UnsafeAny"
			const pendingPersist: Promise<void>[] = []
			const wrappedCallbacks: ToolCallbacks = {
				...callbacks,
				pushToolResult: (content, opts) => {
					capturedResult = content
					if (typeof content === "string" && content.length > 0) {
						// Phase 1: Persist large results to disk (>100KB)
						if (shouldPersistResult(content)) {
							const persistPromise = persistToolResult(content, task.taskId, toolUseId, task.cwd)
								.then((stored) => {
									const message = formatStoredResultMessage(stored)
									logger.info(
										"BaseTool",
										`ToolResultStorage: Persisted ${this.name} result (${stored.totalChars} chars) to ${stored.filePath}`,
									)
									if (cacheKey) {
										toolResultCache.set(cacheKey, message)
									}
									originalPushToolResult(message, opts)
								})
								.catch((err) => {
									// If persistence fails, fall back to token truncation
									logger.error("BaseTool", "ToolResultStorage: Failed to persist result:", err)
									TelemetryService.reportError(
										err instanceof Error ? err : new Error(String(err)),
										TelemetryEventName.UTILITY_ERROR,
									)
									const tokens = estimateTokens(content)
									if (tokens > singleMax) {
										const truncated = truncateToolResult(content, singleMax)
										if (cacheKey) {
											toolResultCache.set(cacheKey, truncated)
										}
										originalPushToolResult(truncated, opts)
									} else {
										if (cacheKey) {
											toolResultCache.set(cacheKey, content)
										}
										originalPushToolResult(content, opts)
									}
								})
							pendingPersist.push(persistPromise)
							return
						}

						// Phase 2: Token budget truncation for medium results
						const tokens = estimateTokens(content)
						if (tokens > singleMax) {
							const truncated = truncateToolResult(content, singleMax)
							logger.info(
								"BaseTool",
								`ToolResultBudget: Truncated ${this.name} result: ${tokens} -> ~${singleMax} tokens`,
							)
							if (cacheKey) {
								toolResultCache.set(cacheKey, truncated)
							}
							originalPushToolResult(truncated, opts)
							return
						}
						if (cacheKey) {
							toolResultCache.set(cacheKey, content)
						}
					}
					// For non-string (array with images) or small results, pass through
					originalPushToolResult(content, opts)
				},
			}

			// Execute with typed parameters, wrapped in retry + hook handling
			const retryable = this.isReadOnly(params as Record<string, UnsafeAny>)
			const maxAttempts = retryable ? 3 : 1
			let attempt = 0
			let lastError: unknown
			while (attempt < maxAttempts) {
				attempt++
				try {
					await this.execute(params, task, wrappedCallbacks)

					// Wait for any pending persistence operations to complete
					if (pendingPersist.length > 0) {
						await Promise.all(pendingPersist)
					}

					if (retryable && attempt > 1) {
						logger.info("BaseTool", `ToolRetry: success tool=${this.name} attempts=${attempt}`)
						recordSecurityMetric("tool_retry_success", { tool: this.name, attempts: attempt })
					}

					// Run post-hooks after successful execution
					try {
						await hookManager.runPostHooks(
							this.name,
							params as Record<string, UnsafeAny>,
							capturedResult,
							hookContext,
						)
					} catch (hookErr) {
						logger.warn("BaseTool", "Post-hook error (ignored):", hookErr)
					}
					toolSpan.end("ok", { stage: "execute", attempts: attempt })
					return
				} catch (error) {
					lastError = error
					if (!retryable || attempt >= maxAttempts || !RetryableError.isRetryable(error)) {
						break
					}
					const backoff = 200 * 2 ** (attempt - 1)
					const jitter = Math.floor(Math.random() * 75)
					const waitMs = backoff + jitter
					logger.warn("BaseTool", `ToolRetry: retry tool=${this.name} attempt=${attempt} waitMs=${waitMs}`)
					recordSecurityMetric("tool_retry", { tool: this.name, attempt, waitMs })
					await new Promise((resolve) => setTimeout(resolve, waitMs))
				}
			}
			try {
				if (pendingPersist.length > 0) {
					await Promise.allSettled(pendingPersist)
				}
				// Run failure hooks
				const error = lastError instanceof Error ? lastError : new Error(String(lastError))
				await hookManager.runFailureHooks(this.name, params as Record<string, UnsafeAny>, error, hookContext)
			} catch (hookErr) {
				logger.warn("BaseTool", "Failure-hook error (ignored):", hookErr)
			}
			toolSpan.end("error", {
				stage: "execute",
				attempts: attempt,
				error: getErrorMessage(lastError),
			})
			throw lastError instanceof Error ? lastError : new Error(String(lastError))
		} finally {
			const durationMs = Date.now() - toolStartAt
			const memEnd = process.memoryUsage()
			const rssMb = Number((memEnd.rss / 1024 / 1024).toFixed(2))
			const heapDeltaMb = Number(((memEnd.heapUsed - memStart.heapUsed) / 1024 / 1024).toFixed(2))
			recordSecurityMetric("tool_exec_duration_ms", { tool: this.name, durationMs })
			recordSecurityMetric("tool_memory_rss_mb", { tool: this.name, rssMb })
			recordSecurityMetric("tool_memory_delta_mb", { tool: this.name, heapDeltaMb })
		}
	}
}
