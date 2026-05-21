import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { ITransportStrategy, TransportCallbacks } from "./ITransportStrategy"
import { StdioTransportStrategy } from "./StdioTransportStrategy"
import { SseTransportStrategy } from "./SseTransportStrategy"
import { StreamableHttpTransportStrategy } from "./StreamableHttpTransportStrategy"

export class TransportFactory {
	private strategies: Map<string, ITransportStrategy>

	constructor() {
		this.strategies = new Map()
		this.register(new StdioTransportStrategy())
		this.register(new SseTransportStrategy())
		this.register(new StreamableHttpTransportStrategy())
	}

	register(strategy: ITransportStrategy): void {
		this.strategies.set(strategy.type, strategy)
	}

	async create(
		name: string,
		type: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport> {
		const strategy = this.strategies.get(type)
		if (!strategy) {
			throw new Error(`Unsupported MCP server type: ${type}`)
		}
		return strategy.createTransport(name, config, callbacks)
	}
}
