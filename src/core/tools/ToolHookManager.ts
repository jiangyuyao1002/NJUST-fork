import type { ToolResponse } from "../../shared/tools"
import type {
	PreToolUseHook,
	PostToolUseHook,
	PostToolUseFailureHook,
	PermissionDeniedHook,
	SessionStartHook,
	SessionEndHook,
	SetupHook,
	StopHook,
	SubagentStartHook,
	SubagentStopHook,
	PreCompactHook,
	PostCompactHook,
	PreCompactHookContext,
	PostCompactHookContext,
	ToolHookContext,
	LifecycleHookContext,
	HookExecutionOrder,
} from "./toolHooks"
import { logger } from "../../shared/logger"

/**
 * Manages registration and execution of all hook types.
 *
 * Supported hook types:
 *   - PreToolUse / PostToolUse / PostToolUseFailure (original 3)
 *   - PermissionDenied (audit logging on denial)
 *   - SessionStart / SessionEnd (task lifecycle)
 *   - Setup / Stop (extension lifecycle)
 *   - SubagentStart / SubagentStop (sub-agent lifecycle)
 *
 * Hooks are executed in registration order. Hook failures are caught and logged
 * so they never block tool execution or lifecycle transitions.
 */
export class ToolHookManager {
	private preHooks: PreToolUseHook[] = []
	private postHooks: PostToolUseHook[] = []
	private failureHooks: PostToolUseFailureHook[] = []

	// New hook storage (Task 2.1)
	private permissionDeniedHooks: PermissionDeniedHook[] = []
	private sessionStartHooks: SessionStartHook[] = []
	private sessionEndHooks: SessionEndHook[] = []
	private setupHooks: SetupHook[] = []
	private stopHooks: StopHook[] = []
	private subagentStartHooks: SubagentStartHook[] = []
	private subagentStopHooks: SubagentStopHook[] = []
	private preCompactHooks: PreCompactHook[] = []
	private postCompactHooks: PostCompactHook[] = []

	/**
	 * Configurable pre-hook execution order.
	 * - 'before-permission': run pre-hooks BEFORE permission checks (CC-aligned, default)
	 * - 'after-permission': run pre-hooks AFTER permission checks (legacy behavior)
	 */
	hookExecutionOrder: HookExecutionOrder = "before-permission"

	// ── Tool execution hook registration ─────────────────────────────

	registerPreHook(hook: PreToolUseHook): void {
		this.preHooks.push(hook)
	}

	registerPostHook(hook: PostToolUseHook): void {
		this.postHooks.push(hook)
	}

	registerFailureHook(hook: PostToolUseFailureHook): void {
		this.failureHooks.push(hook)
	}

	// ── New hook registration (Task 2.1) ─────────────────────────────

	registerPermissionDeniedHook(hook: PermissionDeniedHook): void {
		this.permissionDeniedHooks.push(hook)
	}

	registerSessionStartHook(hook: SessionStartHook): void {
		this.sessionStartHooks.push(hook)
	}

	registerSessionEndHook(hook: SessionEndHook): void {
		this.sessionEndHooks.push(hook)
	}

	registerSetupHook(hook: SetupHook): void {
		this.setupHooks.push(hook)
	}

	registerStopHook(hook: StopHook): void {
		this.stopHooks.push(hook)
	}

	registerSubagentStartHook(hook: SubagentStartHook): void {
		this.subagentStartHooks.push(hook)
	}

	registerSubagentStopHook(hook: SubagentStopHook): void {
		this.subagentStopHooks.push(hook)
	}

	registerPreCompactHook(hook: PreCompactHook): void {
		this.preCompactHooks.push(hook)
	}

	registerPostCompactHook(hook: PostCompactHook): void {
		this.postCompactHooks.push(hook)
	}

	// ── Unregistration ────────────────────────────────────────────────

	unregisterPreHook(hook: PreToolUseHook): void {
		const idx = this.preHooks.indexOf(hook)
		if (idx !== -1) {
			this.preHooks.splice(idx, 1)
		}
	}

	unregisterPostHook(hook: PostToolUseHook): void {
		const idx = this.postHooks.indexOf(hook)
		if (idx !== -1) {
			this.postHooks.splice(idx, 1)
		}
	}

	unregisterFailureHook(hook: PostToolUseFailureHook): void {
		const idx = this.failureHooks.indexOf(hook)
		if (idx !== -1) {
			this.failureHooks.splice(idx, 1)
		}
	}

	// ── Tool execution hooks ─────────────────────────────────────────

	/**
	 * Run all pre-hooks in order. If any hook disallows execution, short-circuit
	 * and return { allow: false }. If a hook provides modifiedInput, pass it
	 * forward to subsequent hooks.
	 */
	async runPreHooks(
		toolName: string,
		input: Record<string, unknown>,
		context: ToolHookContext,
	): Promise<{ allow: boolean; modifiedInput?: Record<string, unknown>; reason?: string }> {
		if (this.preHooks.length === 0) {
			return { allow: true }
		}

		let currentInput = input
		for (const hook of this.preHooks) {
			try {
				const result = await hook(toolName, currentInput, context)
				if (!result.allow) {
					return { allow: false, reason: result.reason }
				}
				if (result.modifiedInput) {
					currentInput = result.modifiedInput
				}
			} catch (err) {
				logger.warn("ToolHookManager", "Pre-hook error (ignored):", err)
				// Hook failure does not block execution
			}
		}

		// If any hook modified the input, include it in the result
		return currentInput !== input ? { allow: true, modifiedInput: currentInput } : { allow: true }
	}

	/**
	 * Run all post-hooks. Errors are caught and logged.
	 */
	async runPostHooks(
		toolName: string,
		input: Record<string, unknown>,
		result: ToolResponse | undefined,
		context: ToolHookContext,
	): Promise<void> {
		for (const hook of this.postHooks) {
			try {
				await hook(toolName, input, result, context)
			} catch (err) {
				logger.warn("ToolHookManager", "Post-hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run all failure hooks. Errors are caught and logged.
	 */
	async runFailureHooks(
		toolName: string,
		input: Record<string, unknown>,
		error: Error,
		context: ToolHookContext,
	): Promise<void> {
		for (const hook of this.failureHooks) {
			try {
				await hook(toolName, input, error, context)
			} catch (err) {
				logger.warn("ToolHookManager", "Failure-hook error (ignored):", err)
			}
		}
	}

	// ── New hook execution (Task 2.1) ────────────────────────────────

	/**
	 * Run permission denied hooks for audit logging.
	 */
	async runPermissionDeniedHooks(
		toolName: string,
		input: Record<string, unknown>,
		reason: string,
		context: ToolHookContext,
	): Promise<void> {
		for (const hook of this.permissionDeniedHooks) {
			try {
				await hook(toolName, input, reason, context)
			} catch (err) {
				logger.warn("ToolHookManager", "PermissionDenied hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run session start hooks.
	 */
	async runSessionStartHooks(context: LifecycleHookContext): Promise<void> {
		for (const hook of this.sessionStartHooks) {
			try {
				await hook(context)
			} catch (err) {
				logger.warn("ToolHookManager", "SessionStart hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run session end hooks.
	 */
	async runSessionEndHooks(context: LifecycleHookContext & { aborted?: boolean }): Promise<void> {
		for (const hook of this.sessionEndHooks) {
			try {
				await hook(context)
			} catch (err) {
				logger.warn("ToolHookManager", "SessionEnd hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run setup hooks (extension activation).
	 */
	async runSetupHooks(context: LifecycleHookContext): Promise<void> {
		for (const hook of this.setupHooks) {
			try {
				await hook(context)
			} catch (err) {
				logger.warn("ToolHookManager", "Setup hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run stop hooks (extension deactivation).
	 */
	async runStopHooks(context: LifecycleHookContext): Promise<void> {
		for (const hook of this.stopHooks) {
			try {
				await hook(context)
			} catch (err) {
				logger.warn("ToolHookManager", "Stop hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run subagent start hooks.
	 */
	async runSubagentStartHooks(parentTaskId: string, agentType: string, context: LifecycleHookContext): Promise<void> {
		for (const hook of this.subagentStartHooks) {
			try {
				await hook(parentTaskId, agentType, context)
			} catch (err) {
				logger.warn("ToolHookManager", "SubagentStart hook error (ignored):", err)
			}
		}
	}

	/**
	 * Run subagent stop hooks.
	 */
	async runSubagentStopHooks(
		parentTaskId: string,
		agentType: string,
		success: boolean,
		context: LifecycleHookContext,
	): Promise<void> {
		for (const hook of this.subagentStopHooks) {
			try {
				await hook(parentTaskId, agentType, success, context)
			} catch (err) {
				logger.warn("ToolHookManager", "SubagentStop hook error (ignored):", err)
			}
		}
	}

	// ── Singleton ─────────────────────────────────────────────────────

	async runPreCompactHooks(context: PreCompactHookContext): Promise<{ allow: boolean; reason?: string }> {
		for (const hook of this.preCompactHooks) {
			try {
				const result = await hook(context)
				if (!result.allow) {
					return { allow: false, reason: result.reason }
				}
			} catch (err) {
				logger.warn("ToolHookManager", "PreCompact hook error (blocking):", err)
				return { allow: false, reason: err instanceof Error ? err.message : String(err) }
			}
		}

		return { allow: true }
	}

	async runPostCompactHooks(context: PostCompactHookContext): Promise<void> {
		for (const hook of this.postCompactHooks) {
			try {
				await hook(context)
			} catch (err) {
				logger.warn("ToolHookManager", "PostCompact hook error (ignored):", err)
			}
		}
	}

	static readonly instance = new ToolHookManager()
}
