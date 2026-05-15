import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http"
import { once } from "events"

import { anthropicSSE } from "./responses/anthropic.js"
import { openAISSE } from "./responses/openai.js"
import { openAIChatCompletionsPath } from "./routes/chat.js"
import { healthPath } from "./routes/health.js"
import { anthropicMessagesPath } from "./routes/messages.js"
import { autoResolveScenario, resolveScenario, type MockProvider, type MockScenarioResponse } from "./scenarios/index.js"

export type MockServerConfig = {
	host?: string
	port?: number
	defaultScenario?: string
	responseDelayMs?: number
	maxBodyBytes?: number
}

export type MockServerHandle = {
	server: Server
	host: string
	port: number
	url: string
	close: () => Promise<void>
}

const readJsonBody = async (request: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> => {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += buffer.length
		if (size > maxBodyBytes) {
			throw Object.assign(new Error("Request body too large"), { statusCode: 413 })
		}
		chunks.push(buffer)
	}
	if (chunks.length === 0) return {}
	const raw = Buffer.concat(chunks).toString("utf8")
	if (!raw.trim()) return {}
	return JSON.parse(raw) as Record<string, unknown>
}

const writeJson = (response: ServerResponse, statusCode: number, body: Record<string, unknown>) => {
	response.writeHead(statusCode, { "content-type": "application/json" })
	response.end(JSON.stringify(body))
}

const selectScenarioName = (
	request: IncomingMessage,
	body: Record<string, unknown>,
): string | undefined => {
	const headerValue = request.headers["x-mock-scenario"]
	if (typeof headerValue === "string" && headerValue.length > 0) return headerValue
	if (typeof body.mock_scenario === "string" && body.mock_scenario.length > 0) return body.mock_scenario
	return undefined
}

const writeSSE = async (response: ServerResponse, chunks: string[], delayMs: number) => {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	})
	for (const chunk of chunks) {
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
		response.write(chunk)
	}
	response.end()
}

const handleCompletion = async (
	provider: MockProvider,
	request: IncomingMessage,
	response: ServerResponse,
	config: Required<Pick<MockServerConfig, "defaultScenario" | "responseDelayMs" | "maxBodyBytes">>,
) => {
	const body = await readJsonBody(request, config.maxBodyBytes)
	const scenarioName = selectScenarioName(request, body)
	const scenario = scenarioName ? resolveScenario(scenarioName) : autoResolveScenario(body) ?? resolveScenario(config.defaultScenario)
	const result: MockScenarioResponse = scenario.resolve({ provider, body })
	if (result.type === "error") {
		writeJson(response, result.status, {
			error: {
				message: result.message,
				type: "mock_api_error",
			},
		})
		return
	}

	await writeSSE(response, provider === "openai" ? openAISSE(result) : anthropicSSE(result), config.responseDelayMs)
}

export function createMockServer(config: MockServerConfig = {}): Server {
	const effectiveConfig = {
		defaultScenario: config.defaultScenario ?? "text-only",
		responseDelayMs: config.responseDelayMs ?? 0,
		maxBodyBytes: config.maxBodyBytes ?? 1_000_000,
	}

	return createServer((request, response) => {
		void (async () => {
			try {
				if (request.method === "GET" && request.url === healthPath) {
					writeJson(response, 200, { status: "ok" })
					return
				}
				if (request.method === "POST" && request.url === openAIChatCompletionsPath) {
					await handleCompletion("openai", request, response, effectiveConfig)
					return
				}
				if (request.method === "POST" && request.url === anthropicMessagesPath) {
					await handleCompletion("anthropic", request, response, effectiveConfig)
					return
				}
				writeJson(response, 404, { error: "not_found" })
			} catch (error) {
				const statusCode =
					error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
						? error.statusCode
						: 500
				writeJson(response, statusCode, {
					error: error instanceof Error ? error.message : "unknown_error",
				})
			}
		})()
	})
}

export async function startMockServer(config: MockServerConfig = {}): Promise<MockServerHandle> {
	const host = config.host ?? "127.0.0.1"
	const server = createMockServer(config)
	server.listen(config.port ?? 0, host)
	await once(server, "listening")
	const address = server.address()
	if (!address || typeof address === "string") {
		throw new Error("Mock API server did not bind to a TCP port")
	}
	const url = `http://${host}:${address.port}`
	return {
		server,
		host,
		port: address.port,
		url,
		close: async () => {
			server.close()
			await once(server, "close")
		},
	}
}
