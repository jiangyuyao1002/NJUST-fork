import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface TransportCallbacks {
	onError: (error: Error | unknown) => void | Promise<void>
	onClose: () => void | Promise<void>
	onStderr?: (data: Buffer) => void // stdio only
	/**
	 * Called when all reconnection attempts have been exhausted.
	 * The transport will not attempt to reconnect again until manually restarted.
	 */
	onReconnectExhausted?: (name: string) => void | Promise<void>
}

export interface ITransportStrategy {
	readonly type: string
	createTransport(
		name: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport>
}
