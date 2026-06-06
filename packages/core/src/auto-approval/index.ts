import type { UnsafeAny } from "@njust-ai/types"
import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
	ALWAYS_ALLOW_ALL_MODES,
} from "@njust-ai/types"

import { ClineAskResponse } from "../shared/WebviewMessage.js"
import { logger } from "../shared/logger.js"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools.js"
import { isMcpToolAlwaysAllowed } from "./mcp.js"
import { getCommandDecision } from "./commands.js"
import { classifyBashCommand } from "./bashClassifier.js"
import { matchPatternRules, type PatternRule } from "./patternRules.js"

/**
 * Commands that ALWAYS require user confirmation, even when Force Bypass
 * (alwaysAllowAll) is active.  Covers destructive deletions and VCS commits.
 */
const ALWAYS_REQUIRE_CONFIRM_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\brd\b/i,
	/\bRemove-Item\b/i,
	/\bdel(?=\s|"|')/i,
	/\bgit\s+commit\b/i,
]

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"
	| "commandPatternRules"

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ClineAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
}: {
	state?: Partial<ExtensionState> & Record<string, UnsafeAny>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
}): Promise<CheckAutoApprovalResult> {
	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	// Master "approve all" toggle: when enabled AND the current mode is in
	// the allowed list, approve everything without checking individual toggles.
	// In disallowed modes the toggle is silently ignored (falls through to
	// per-category checks below).
	//
	// Exception: delete and commit commands ALWAYS require user confirmation,
	// even when bypass is active.
	if (
		state.alwaysAllowAll === true &&
		state.mode &&
		(ALWAYS_ALLOW_ALL_MODES as readonly string[]).includes(state.mode)
	) {
		if (ask === "command" && text && ALWAYS_REQUIRE_CONFIRM_PATTERNS.some((p) => p.test(text))) {
			return { decision: "ask" }
		}
		return { decision: "approve" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		// Always classify dangerous commands first - pattern rules cannot override this.
		const risk = classifyBashCommand(text)
		if (risk === "dangerous") return { decision: "deny" }

		const patternRules = ((state as Record<string, UnsafeAny>)?.commandPatternRules ?? []) as PatternRule[]
		const patternDecision = matchPatternRules(text, patternRules)
		if (patternDecision === "allow") return { decision: "approve" }
		if (patternDecision === "deny") return { decision: "deny" }

		if (risk === "medium" && state.alwaysAllowExecute !== true) return { decision: "ask" }

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			logger.error("AutoApproval", "Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		// updateTodoList is a low-risk UI-only operation (no file or network access).
		// Auto-approve when auto-approval is enabled; otherwise require confirmation.
		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files — skills must be explicitly installed/defined by the user.
		// However, skills may trigger subsequent tool calls which are individually evaluated.
		// Only auto-approve when the user has explicitly enabled read-only auto-approval.
		if (tool.tool === "skill") {
			return state.alwaysAllowReadOnly === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		if (["newTask", "finishTask", "send_message", "agent"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler.js"
export { containsDangerousSubstitution, getCommandDecision, getSingleCommandDecision } from "./commands.js"
