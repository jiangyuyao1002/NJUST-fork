import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { ITransportStrategy, TransportCallbacks } from "./ITransportStrategy"

export class StreamableHttpTransportStrategy implements ITransportStrategy {
	readonly type = "streamable-http"

	async createTransport(
		name: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<StreamableHTTPClientTransport> {
		// MCP server URLs are user-configured — the user explicitly trusts these endpoints.
		// SSRF guards are intentionally NOT applied here (see SseTransportStrategy for rationale).

		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: {
				headers: config.headers,
			},
		})

		// Set up Streamable HTTP specific error handling
		transport.onerror = async (error) => {
			await callbacks.onError(error)
		}

		transport.onclose = async () => {
			await callbacks.onClose()
		}

		return transport
	}
}
