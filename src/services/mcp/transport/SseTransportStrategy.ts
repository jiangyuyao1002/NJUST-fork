import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import ReconnectingEventSource from "reconnecting-eventsource"

import type { ITransportStrategy, TransportCallbacks } from "./ITransportStrategy"

export class SseTransportStrategy implements ITransportStrategy {
	readonly type = "sse"

	async createTransport(
		name: string,
		config: Record<string, UnsafeAny>,
		callbacks: TransportCallbacks,
	): Promise<SSEClientTransport> {
		// MCP server URLs are user-configured — the user explicitly trusts these endpoints.
		// SSRF guards (assertSafeOutboundUrl) are intentionally NOT applied here, as they
		// would block legitimate local MCP servers (localhost, private network addresses).
		// NOTE: The configuration schema validates URL format only, not protocol or hostname.
		// The trust boundary is the user's explicit configuration action.

		const sseOptions = {
			requestInit: {
				headers: config.headers,
			},
		}

		// Configure ReconnectingEventSource options with exponential
		// backoff and jitter to avoid thundering-herd on reconnect.
		const baseRetryMs = 1000
		const maxRetryMs = 60_000
		const jitter = Math.floor(Math.random() * 1000)
		// Exponential backoff capped at 2^5 (32x) to avoid excessive wait times.
		const expBackoff = Math.min(baseRetryMs * Math.pow(2, 5), maxRetryMs)
		const reconnectingEventSourceOptions = {
			max_retry_time: expBackoff + jitter,
			withCredentials: config.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
			fetch: (url: string | URL, init: RequestInit) => {
				const headers = new Headers({ ...(init?.headers || {}), ...(config.headers || {}) })
				return fetch(url, {
					...init,
					headers,
				})
			},
		}

		global.EventSource = ReconnectingEventSource
		const transport = new SSEClientTransport(new URL(config.url), {
			...sseOptions,
			eventSourceInit: reconnectingEventSourceOptions,
		})

		// Set up SSE specific error handling
		transport.onerror = async (error) => {
			await callbacks.onError(error)
		}

		transport.onclose = async () => {
			await callbacks.onClose()
		}

		return transport
	}
}
