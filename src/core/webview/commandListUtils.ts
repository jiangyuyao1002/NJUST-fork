/**
 * Command list utilities for merging and normalizing allowed/denied command lists.
 */

import { logger } from "../../shared/logger"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

/**
 * Normalizes a command list by filtering invalid entries and trimming whitespace.
 */
export function normalizeCommandList(commands?: string[]): string[] {
	if (!Array.isArray(commands) || commands.length === 0) {
		return []
	}

	const normalized: string[] = []
	for (const cmd of commands) {
		if (typeof cmd === "string") {
			const trimmed = cmd.trim()
			if (trimmed.length > 0) normalized.push(trimmed)
		}
	}
	return normalized
}

/**
 * Common utility for merging command lists from global state and workspace configuration.
 * Global state takes precedence over workspace configuration.
 */
export function mergeCommandLists(
	globalStateCommands?: string[],
	workspaceCommands?: string[],
	commandType?: "allowed" | "denied",
): string[] {
	try {
		const validGlobalCommands = normalizeCommandList(globalStateCommands)
		const validWorkspaceCommands = normalizeCommandList(workspaceCommands)
		return [...new Set([...validGlobalCommands, ...validWorkspaceCommands])]
	} catch (error) {
		if (commandType) {
			logger.error("CommandListUtils", `Error merging ${commandType} commands:`, error)
		}
		TelemetryService.reportError(error, TelemetryEventName.WEBVIEW_ERROR)
		return []
	}
}

/**
 * Merges allowed commands from global state and workspace configuration
 * with proper validation and deduplication.
 */
export function mergeAllowedCommands(globalStateCommands?: string[], workspaceCommands?: string[]): string[] {
	return mergeCommandLists(globalStateCommands, workspaceCommands, "allowed")
}

/**
 * Merges denied commands from global state and workspace configuration
 * with proper validation and deduplication.
 */
export function mergeDeniedCommands(globalStateCommands?: string[], workspaceCommands?: string[]): string[] {
	return mergeCommandLists(globalStateCommands, workspaceCommands, "denied")
}
