import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { McpProtocolAdapter } from "../adapters/McpProtocolAdapter"
import type { CloudAgentProfile } from "../types/profile"

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: vi.fn((e) => String(e)),
}))

function createMockProfile(): CloudAgentProfile {
	return {
		id: "test-mcp-profile",
		name: "Test MCP Profile",
		protocolType: "mcp",
		serverUrl: "http://127.0.0.1:0",
		auth: { type: "api-key", apiKey: "test-key", deviceTokenSource: "global" },
		createdAt: Date.now(),
		updatedAt: Date.now(),
	}
}

function createInMemoryMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "test-cloud-agent", version: "1.0.0" },
		{ capabilities: { tools: {} } },
	)

	server.tool(
		"submit_task",
		"Submit a coding task",
		{
			sessionId: z.string(),
			message: z.string(),
			workspacePath: z.string().optional(),
		},
		async (params, extra) => {
			await extra.sendNotification({
				method: "notifications/cloudagent/text",
				params: { content: "Processing task..." },
			})

			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						ok: true,
						status: "done",
						run_id: "run-inmemory",
						text: "Task completed via InMemory transport",
						logs: ["step 1 done", "step 2 done"],
						memory_summary: "Test memory summary",
						tokens_in: 50,
						tokens_out: 100,
						cost: 0.01,
					}),
				}],
			}
		},
	)

	server.tool(
		"compile",
		"Run compilation",
		{
			sessionId: z.string(),
			workspacePath: z.string().optional(),
		},
		async () => ({
			content: [{
				type: "text",
				text: JSON.stringify({ success: true, output: "Build OK (in-memory)" }),
			}],
		}),
	)

	return server
}

describe("McpProtocolAdapter Integration (InMemory)", () => {
	let adapter: McpProtocolAdapter
	let server: McpServer
	let clientTransport: InMemoryTransport
	let serverTransport: InMemoryTransport

	beforeEach(async () => {
		;[clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
		server = createInMemoryMcpServer()
		await server.connect(serverTransport)

		adapter = new McpProtocolAdapter()
		adapter.initialize(createMockProfile())
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(adapter as any).transport = clientTransport
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(adapter as any).client = new Client(
			{ name: "njust-ai-cj", version: "1.0.0" },
			{ capabilities: {} },
		)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (adapter as any).client.connect(clientTransport)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(adapter as any).connected = true
	})

	afterEach(async () => {
		await adapter.disconnect().catch(() => {})
		await server.close().catch(() => {})
	})

	it("should call submit_task and parse response", async () => {
		const result = await adapter.callTool("submit_task", {
			sessionId: "test-session",
			message: "hello",
		})

		expect(result.ok).toBe(true)
		expect(result.status).toBe("done")
		expect(result.runId).toBe("run-inmemory")
		expect(result.text).toBe("Task completed via InMemory transport")
		expect(result.logs).toEqual(["step 1 done", "step 2 done"])
		expect(result.memorySummary).toBe("Test memory summary")
		expect(result.tokensIn).toBe(50)
		expect(result.tokensOut).toBe(100)
		expect(result.cost).toBe(0.01)
	})

	it("should call compile and parse response", async () => {
		const result = await adapter.callTool("compile", {
			sessionId: "test-session",
			workspacePath: "/test",
		})

		const compileResult = adapter.parseCompileResponse(result.raw ?? {})
		expect(compileResult.success).toBe(true)
		expect(compileResult.output).toBe("Build OK (in-memory)")
	})

	it("should build request body with dual format", () => {
		const body = adapter.buildRequestBody({
			goal: "test goal",
			sessionId: "session-123",
			workspacePath: "/test/path",
		})

		expect(body.goal).toBe("test goal")
		expect(body.session_id).toBe("session-123")
		expect(body.message).toBe("test goal")
		expect(body.sessionId).toBe("session-123")
	})

	it("should parse MCP ToolResult format via parseResponseBody", () => {
		const mcpResult = {
			content: [{
				type: "text",
				text: JSON.stringify({
					ok: true,
					status: "done",
					run_id: "run-test",
					pending_tools: [
						{ call_id: "c1", tool: "read_file", arguments: { path: "a.txt" } },
					],
				}),
			}],
		}

		const result = adapter.parseResponseBody(mcpResult)
		expect(result.ok).toBe(true)
		expect(result.pendingTools).toHaveLength(1)
		expect(result.pendingTools?.[0]?.callId).toBe("c1")
	})

	it("should parse fallback format", () => {
		const result = adapter.parseResponseBody({
			ok: false,
			status: "done",
			text: "direct text",
		})
		expect(result.ok).toBe(false)
		expect(result.text).toBe("direct text")
	})

	it("should handle non-array pending_tools gracefully", () => {
		const mcpResult = {
			content: [{
				type: "text",
				text: JSON.stringify({ pending_tools: "not-array" }),
			}],
		}
		const result = adapter.parseResponseBody(mcpResult)
		expect(result.pendingTools).toEqual([])
	})

	it("should disconnect cleanly", async () => {
		await adapter.disconnect()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect((adapter as any).connected).toBe(false)
	})
})
