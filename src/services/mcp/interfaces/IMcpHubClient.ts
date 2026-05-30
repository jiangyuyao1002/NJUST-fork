import type * as vscode from "vscode"

import type { ExtensionMessage } from "@njust-ai/types"

import type { TaskHostState } from "../../../core/task/interfaces/taskHostState"

import type { IMcpStatusSink } from "./IMcpStatusSink"

/**
 * Environment + UI hooks required by McpHub / McpServerManager without importing ClineProvider.
 */
export interface IMcpHubClient extends IMcpStatusSink {
	readonly cwd: string
	readonly context: vscode.ExtensionContext

	getState(): Promise<TaskHostState>

	ensureMcpServersDirectoryExists(): Promise<string>

	ensureSettingsDirectoryExists(): Promise<string>

	postMessageToWebview(message: ExtensionMessage): Promise<void>

	getExtensionPackageVersion(): string
}
