import type {
	McpResourceResponse,
	McpServer,
	McpToolCallResponse,
} from "@njust-ai-cj/types"

import type { McpConnection } from "../McpHub"

/**
 * Public service surface of McpHub, consumed by ClineProvider, ITaskHost,
 * system prompt builders, and webview message handlers.
 *
 * McpHub implements this interface; all other modules depend only on this
 * abstraction, breaking the concrete-class coupling to McpHub.
 */
export interface IMcpHubService {
	// ── State ────────────────────────────────────────────────────────
	connections: McpConnection[]
	isConnecting: boolean

	// ── Lifecycle ─────────────────────────────────────────────────────
	waitUntilReady(): Promise<void>
	registerClient(): void
	unregisterClient(): Promise<void>
	dispose(): Promise<void>

	// ── Server queries ────────────────────────────────────────────────
	getServers(): McpServer[]
	getAllServers(): McpServer[]
	getMcpServersPath(): Promise<string>
	getMcpSettingsFilePath(): Promise<string>
	findServerNameBySanitizedName(sanitizedServerName: string): string | null

	// ── Connection management ────────────────────────────────────────
	refreshAllConnections(): Promise<void>
	restartConnection(serverName: string, source?: "global" | "project"): Promise<void>
	deleteConnection(name: string, source?: "global" | "project"): Promise<void>
	updateServerConnections(
		newServers: Record<string, UnsafeAny>,
		source?: "global" | "project",
		manageConnectingState?: boolean,
	): Promise<void>
	refreshTools(serverName?: string): Promise<Map<string, number>>

	// ── Server settings ──────────────────────────────────────────────
	toggleServerDisabled(serverName: string, disabled: boolean, source?: "global" | "project"): Promise<void>
	updateServerTimeout(serverName: string, timeout: number, source?: "global" | "project"): Promise<void>
	deleteServer(serverName: string, source?: "global" | "project"): Promise<void>
	handleMcpEnabledChange(enabled: boolean): Promise<void>

	// ── Tool / resource invocation ───────────────────────────────────
	callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, UnsafeAny>,
		source?: "global" | "project",
	): Promise<McpToolCallResponse>
	readResource(serverName: string, uri: string, source?: "global" | "project"): Promise<McpResourceResponse>

	// ── Tool configuration ───────────────────────────────────────────
	toggleToolAlwaysAllow(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		shouldAllow: boolean,
	): Promise<void>
	toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		isEnabled: boolean,
	): Promise<void>
}
