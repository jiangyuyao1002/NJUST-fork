import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface TransportCallbacks {
	onError: (error: Error | unknown) => void | Promise<void>
	onClose: () => void | Promise<void>
	onStderr?: (data: Buffer) => void // stdio only
}

export interface ITransportStrategy {
	readonly type: string
	createTransport(
		name: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport>
}
