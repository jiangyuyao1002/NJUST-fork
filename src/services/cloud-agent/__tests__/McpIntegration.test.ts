import { describe, expect, it, beforeAll, afterAll } from "vitest"
import http from "http"
import { McpProtocolAdapter } from "../adapters/McpProtocolAdapter"
import type { CloudAgentProfile } from "../types/profile"

let testPort = 0
let testServer: http.Server

function createMcpProfile(): CloudAgentProfile {
	return {
		id: "test-mcp-profile",
		name: "Test MCP Profile",
		protocolType: "mcp",
		serverUrl: `http://127.0.0.1:${testPort}`,
		auth: { type: "api-key", apiKey: "test-key", deviceTokenSource: "global" },
		createdAt: Date.now(),
		updatedAt: Date.now(),
	}
}

function createInProcessMockServer(): Promise<http.Server> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ status: "ok" }))
		})

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address()
			if (addr && typeof addr === "object") {
				testPort = addr.port
			}
			resolve(server)
		})

		server.on("error", reject)
	})
}

describe("McpProtocolAdapter Integration", () => {
	let adapter: McpProtocolAdapter

	beforeAll(async () => {
		testServer = await createInProcessMockServer()
		adapter = new McpProtocolAdapter()
		adapter.initialize(createMcpProfile())
	}, 10000)

	afterAll(() => {
		adapter?.disconnect().catch(() => {})
		testServer?.close()
	})

	it("should have correct protocol type", () => {
		expect(adapter.protocolType).toBe("mcp")
	})

	it("should initialize with profile", () => {
		expect(() => adapter.initialize(createMcpProfile())).not.toThrow()
	})

	it("should build request body with dual format", () => {
		const body = adapter.buildRequestBody({
			goal: "test goal",
			sessionId: "session-123",
			workspacePath: "/test/path",
		})

		// snake_case
		expect(body.goal).toBe("test goal")
		expect(body.session_id).toBe("session-123")
		expect(body.workspace_path).toBe("/test/path")

		// camelCase
		expect(body.message).toBe("test goal")
		expect(body.sessionId).toBe("session-123")
		expect(body.workspacePath).toBe("/test/path")
	})

	it("should parse MCP ToolResult format", () => {
		const mcpResult = {
			content: [{
				type: "text",
				text: JSON.stringify({
					ok: true,
					status: "done",
					run_id: "run-test",
					text: "result",
					pending_tools: [
						{ call_id: "c1", tool: "read_file", arguments: { path: "a.txt" } },
					],
				}),
			}],
		}

		const result = adapter.parseResponseBody(mcpResult)

		expect(result.ok).toBe(true)
		expect(result.status).toBe("done")
		expect(result.runId).toBe("run-test")
		expect(result.text).toBe("result")
		expect(result.pendingTools).toHaveLength(1)
		expect(result.pendingTools?.[0]?.callId).toBe("c1")
	})

	it("should parse fallback format", () => {
		const directResult = {
			ok: false,
			status: "done",
			run_id: "run-direct",
			text: "direct text",
		}

		const result = adapter.parseResponseBody(directResult)
		expect(result.ok).toBe(false)
		expect(result.runId).toBe("run-direct")
		expect(result.text).toBe("direct text")
	})

	it("should return empty string for getEndpoint", () => {
		expect(adapter.getEndpoint("health")).toBe("")
		expect(adapter.getEndpoint("run")).toBe("")
	})

	it("should return empty object for buildAuthHeaders", () => {
		expect(adapter.buildAuthHeaders()).toEqual({})
	})

	it("should handle connect failure gracefully", async () => {
		// In-process mock server is NOT an MCP server,
		// so connect should fail (no MCP handshake support)
		await expect(adapter.connect()).rejects.toThrow()
	})
})
