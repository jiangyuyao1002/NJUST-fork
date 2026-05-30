import type { McpServer } from "@njust-ai/types"

/**
 * MCP hub → UI status updates. Implemented by ClineProvider (or tests).
 * Decouples services/mcp from core/webview concrete class imports.
 */
export interface IMcpStatusSink {
	/** Full server list changed; webview should refresh MCP server state. */
	onMcpServersUpdated(servers: McpServer[]): Promise<void>
}
