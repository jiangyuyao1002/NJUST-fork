import type { ToolResponse } from "../../shared/tools"

/**
 * Hook context information passed to all hook types.
 */
export interface ToolHookContext {
	taskId: string
	toolUseId: string
	cwd: string
}

/**
 * Extended context for lifecycle hooks that don't have tool-specific info.
 */
export interface LifecycleHookContext {
	taskId?: string
	cwd?: string
	/** Arbitrary metadata provided by the hook trigger site. */
	metadata?: Record<string, unknown>
}

// ── Tool execution hooks (existing) ──────────────────────────────────

/**
 * Pre-execution hook: can block or modify input.
 * Runs before tool execute(). If allow=false, execution is skipped.
 */
export type PreToolUseHook = (
	toolName: string,
	input: Record<string, unknown>,
	context: ToolHookContext,
) => Promise<{ allow: boolean; modifiedInput?: Record<string, unknown>; reason?: string }>

/**
 * Post-execution hook: for logging, auditing, etc.
 * Runs after successful tool execution.
 */
export type PostToolUseHook = (
	toolName: string,
	input: Record<string, unknown>,
	result: ToolResponse | undefined,
	context: ToolHookContext,
) => Promise<void>

/**
 * Post-failure hook: for error tracking.
 * Runs when tool execution throws an error.
 */
export type PostToolUseFailureHook = (
	toolName: string,
	input: Record<string, unknown>,
	error: Error,
	context: ToolHookContext,
) => Promise<void>

// ── New hook types (Task 2.1) ────────────────────────────────────────

/**
 * Permission denied hook: triggered when a tool invocation is denied.
 * Used for audit logging and denial tracking.
 */
export type PermissionDeniedHook = (
	toolName: string,
	input: Record<string, unknown>,
	reason: string,
	context: ToolHookContext,
) => Promise<void>

/**
 * Session start hook: triggered when a new task/session begins.
 */
export type SessionStartHook = (context: LifecycleHookContext) => Promise<void>

/**
 * Session end hook: triggered when a task/session completes or is aborted.
 */
export type SessionEndHook = (context: LifecycleHookContext & { aborted?: boolean }) => Promise<void>

/**
 * Setup hook: triggered during extension activation / system initialization.
 */
export type SetupHook = (context: LifecycleHookContext) => Promise<void>

/**
 * Stop hook: triggered during extension deactivation / system cleanup.
 */
export type StopHook = (context: LifecycleHookContext) => Promise<void>

/**
 * Subagent start hook: triggered when a sub-agent is spawned.
 */
export type SubagentStartHook = (
	parentTaskId: string,
	agentType: string,
	context: LifecycleHookContext,
) => Promise<void>

/**
 * Subagent stop hook: triggered when a sub-agent completes.
 */
export type SubagentStopHook = (
	parentTaskId: string,
	agentType: string,
	success: boolean,
	context: LifecycleHookContext,
) => Promise<void>

export interface PreCompactHookContext extends LifecycleHookContext {
	messageCount: number
	tokenCount: number
}

export interface PostCompactHookContext extends LifecycleHookContext {
	messageCountBefore: number
	messageCountAfter: number
	tokenCountBefore: number
	tokenCountAfter: number
}

export type PreCompactHook = (context: PreCompactHookContext) => Promise<{ allow: boolean; reason?: string }>

export type PostCompactHook = (context: PostCompactHookContext) => Promise<void>

/**
 * All supported hook event types.
 */
export type HookEventType =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "PermissionDenied"
	| "SessionStart"
	| "SessionEnd"
	| "Setup"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "PreCompact"
	| "PostCompact"

/**
 * Configuration for hook execution ordering.
 */
export type HookExecutionOrder = "before-permission" | "after-permission"
