import * as vscode from "vscode"

import { DEFAULT_CLOUD_AGENT_URL } from "@njust-ai-cj/types"
import { Package } from "../../shared/package"
import { mergeAllowedCommands, mergeDeniedCommands } from "./commandListUtils"

export function getMergedCommandLists(
	allowedCommands?: string[],
	deniedCommands?: string[],
): { allowedCommands: string[]; deniedCommands: string[] } {
	const workspaceConfig = vscode.workspace.getConfiguration(Package.name)
	return {
		allowedCommands: mergeAllowedCommands(allowedCommands, workspaceConfig.get<string[]>("allowedCommands") || []),
		deniedCommands: mergeDeniedCommands(deniedCommands, workspaceConfig.get<string[]>("deniedCommands") || []),
	}
}

export function computePermissionMode(state: {
	autoApprovalEnabled?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowReadOnly?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
}): "default" | "bypass" {
	const allBypass =
		(state.autoApprovalEnabled ?? false) &&
		(state.alwaysAllowExecute ?? false) &&
		(state.alwaysAllowWrite ?? false) &&
		(state.alwaysAllowWriteOutsideWorkspace ?? false) &&
		(state.alwaysAllowWriteProtected ?? false) &&
		(state.alwaysAllowReadOnly ?? false) &&
		(state.alwaysAllowReadOnlyOutsideWorkspace ?? false) &&
		(state.alwaysAllowMcp ?? false) &&
		(state.alwaysAllowModeSwitch ?? false) &&
		(state.alwaysAllowSubtasks ?? false)

	return allBypass ? "bypass" : "default"
}

export function getWorkspaceWebviewConfig(): {
	cloudAgentServerUrl: string
	debug: boolean
	saveAllBeforeExecuteCommand: boolean
	inlineCompletionEnabled: boolean
	inlineCompletionTriggerDelayMs: number
	inlineCompletionMaxLines: number
	inlineCompletionEnableCangjieEnhanced: boolean
	inlineCompletionTriggerCommand: string
} {
	const workspaceConfig = vscode.workspace.getConfiguration(Package.name)
	return {
		cloudAgentServerUrl: workspaceConfig.get<string>("cloudAgent.serverUrl", DEFAULT_CLOUD_AGENT_URL) ?? DEFAULT_CLOUD_AGENT_URL,
		debug: workspaceConfig.get<boolean>("debug", false),
		saveAllBeforeExecuteCommand: workspaceConfig.get<boolean>("saveAllBeforeExecuteCommand", true),
		inlineCompletionEnabled: workspaceConfig.get<boolean>("inlineCompletion.enabled", true),
		inlineCompletionTriggerDelayMs: workspaceConfig.get<number>("inlineCompletion.triggerDelayMs", 300),
		inlineCompletionMaxLines: workspaceConfig.get<number>("inlineCompletion.maxLines", 10),
		inlineCompletionEnableCangjieEnhanced: workspaceConfig.get<boolean>(
			"inlineCompletion.enableCangjieEnhanced",
			true,
		),
		inlineCompletionTriggerCommand: workspaceConfig.get<string>("inlineCompletion.triggerCommand", "alt+\\"),
	}
}
