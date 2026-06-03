/**
 * AuditSink — bridges ToolHookManager events to AuditLogger.
 *
 * Registers hooks on the ToolHookManager singleton so that every
 * tool execution, permission denial, session lifecycle event, and
 * subagent lifecycle event is automatically captured in the audit log.
 *
 * This is a zero-modification integration: existing code does not
 * need to change — it simply triggers hooks as usual.
 */

import type { AuditLogger } from "./AuditLogger"
import type { AuditEntry } from "./AuditLogger"
import { ToolHookManager } from "../core/tools/ToolHookManager"

export class AuditSink {
	private hookManager: ToolHookManager

	constructor(
		private auditLogger: AuditLogger,
		hookManager?: ToolHookManager,
	) {
		this.hookManager = hookManager ?? ToolHookManager.instance
		this.registerAllHooks()
	}

	/** Manually emit a custom audit entry (for events not covered by hooks). */
	emit(entry: AuditEntry): void {
		this.auditLogger.log(entry)
	}

	/** Dispose is a no-op — AuditLogger owns the stream lifecycle. */
	dispose(): void {
		// Hooks are fire-and-forget; nothing to unregister.
	}

	private registerAllHooks(): void {
		// ── Tool execution hooks ─────────────────────────────────

		this.hookManager.registerPostHook(async (toolName, input, _result, ctx) => {
			this.log({
				category: "tool.execution",
				action: `tool.${toolName}`,
				taskId: ctx.taskId,
				tool: toolName,
				outcome: "success",
				meta: { toolUseId: ctx.toolUseId, inputSummary: summarizeInput(input) },
			})
		})

		this.hookManager.registerFailureHook(async (toolName, _input, error, ctx) => {
			this.log({
				category: "tool.execution",
				action: `tool.${toolName}`,
				taskId: ctx.taskId,
				tool: toolName,
				outcome: "error",
				meta: { toolUseId: ctx.toolUseId, errorMessage: error.message },
			})
		})

		// ── Permission denied hook ───────────────────────────────

		this.hookManager.registerPermissionDeniedHook(async (toolName, _input, reason, ctx) => {
			this.log({
				category: "tool.permission",
				action: `permission.denied.${toolName}`,
				taskId: ctx.taskId,
				tool: toolName,
				outcome: "denied",
				meta: { reason, toolUseId: ctx.toolUseId },
			})
		})

		// ── Session lifecycle hooks ──────────────────────────────

		this.hookManager.registerSessionStartHook(async (ctx) => {
			this.log({
				category: "session.lifecycle",
				action: "session.start",
				taskId: ctx.taskId,
				outcome: "success",
			})
		})

		this.hookManager.registerSessionEndHook(async (ctx) => {
			this.log({
				category: "session.lifecycle",
				action: ctx.aborted ? "session.aborted" : "session.end",
				taskId: ctx.taskId,
				outcome: ctx.aborted ? "error" : "success",
			})
		})

		// ── Subagent lifecycle hooks ─────────────────────────────

		this.hookManager.registerSubagentStartHook(async (parentTaskId, agentType, ctx) => {
			this.log({
				category: "subagent.lifecycle",
				action: "subagent.start",
				taskId: parentTaskId,
				outcome: "success",
				meta: { agentType, childTaskId: ctx.taskId },
			})
		})

		this.hookManager.registerSubagentStopHook(async (parentTaskId, agentType, success, ctx) => {
			this.log({
				category: "subagent.lifecycle",
				action: "subagent.stop",
				taskId: parentTaskId,
				outcome: success ? "success" : "error",
				meta: { agentType, childTaskId: ctx.taskId },
			})
		})
	}

	private log(partial: Omit<AuditEntry, "timestamp">): void {
		this.auditLogger.log({ ...partial, timestamp: new Date().toISOString() })
	}
}

/** Truncate tool input to a short summary (avoid logging large payloads). */
function summarizeInput(input: Record<string, unknown>): string {
	const json = JSON.stringify(input)
	return json.length > 300 ? json.slice(0, 300) + "…" : json
}
