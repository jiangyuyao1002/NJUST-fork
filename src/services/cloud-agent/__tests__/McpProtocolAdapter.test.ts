import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { McpProtocolAdapter } from "../adapters/McpProtocolAdapter"
import type { CloudAgentProfile } from "../types/profile"

// Mock MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
		callTool: vi.fn().mockResolvedValue({
			content: [{ type: "text", text: JSON.stringify({ ok: true, text: "test result" }) }],
		}),
	})),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
		// mock transport
	})),
}))

vi.mock("../../../shared/logger", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: vi.fn((e) => String(e)),
}))

function createMockProfile(overrides?: Partial<CloudAgentProfile>): CloudAgentProfile {
	return {
		id: "test-profile",
		name: "Test Profile",
		protocolType: "mcp",
		serverUrl: "http://localhost:8765",
		auth: { type: "api-key", apiKey: "secret-key", deviceTokenSource: "global" },
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as CloudAgentProfile
}

describe("McpProtocolAdapter", () => {
	let adapter: McpProtocolAdapter

	beforeEach(() => {
		adapter = new McpProtocolAdapter()
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("should have correct protocol type", () => {
		expect(adapter.protocolType).toBe("mcp")
	})

	it("should initialize with profile", () => {
		const profile = createMockProfile()
		expect(() => adapter.initialize(profile)).not.toThrow()
	})

	it("should connect and check capabilities", async () => {
		const profile = createMockProfile()
		adapter.initialize(profile)
		await adapter.connect()
		// Client.connect and getServerCapabilities should be called
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const mockClient = vi.mocked(Client).mock.results[0]?.value
		expect(mockClient?.connect).toHaveBeenCalled()
		expect(mockClient?.getServerCapabilities).toHaveBeenCalled()
	})

	it("should throw error if server lacks tools capability", async () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		// Override getServerCapabilities to return no tools
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const mockClient = vi.mocked(Client).mock.results[0]?.value
		mockClient.getServerCapabilities.mockReturnValue({})

		await expect(adapter.connect()).rejects.toThrow("MCP server does not support tools capability")
	})

	it("should disconnect correctly", async () => {
		const profile = createMockProfile()
		adapter.initialize(profile)
		await adapter.connect()
		await adapter.disconnect()

		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const mockClient = vi.mocked(Client).mock.results[0]?.value
		expect(mockClient?.close).toHaveBeenCalled()
	})

	it("should build request body with both snake_case and camelCase", () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		const body = adapter.buildRequestBody({
			goal: "test goal",
			sessionId: "session-123",
			workspacePath: "/test/path",
			images: ["img1", "img2"],
			runId: "run-456",
		})

		// snake_case
		expect(body.goal).toBe("test goal")
		expect(body.session_id).toBe("session-123")
		expect(body.workspace_path).toBe("/test/path")
		expect(body.images).toEqual(["img1", "img2"])
		expect(body.run_id).toBe("run-456")

		// camelCase
		expect(body.message).toBe("test goal")
		expect(body.sessionId).toBe("session-123")
		expect(body.workspacePath).toBe("/test/path")
	})

	it("should parse MCP ToolResult format", () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		const mcpResult = {
			content: [{
				type: "text",
				text: JSON.stringify({
					ok: true,
					status: "done",
					run_id: "run-789",
					text: "result text",
					reasoning: "reasoning text",
					logs: ["log1", "log2"],
					memory_summary: "memory",
					tokens_in: 100,
					tokens_out: 200,
					cost: 0.05,
					pending_tools: [
						{ call_id: "call-1", tool: "read_file", arguments: { path: "test.txt" } },
					],
				}),
			}],
		}

		const result = adapter.parseResponseBody(mcpResult)

		expect(result.ok).toBe(true)
		expect(result.status).toBe("done")
		expect(result.runId).toBe("run-789")
		expect(result.text).toBe("result text")
		expect(result.reasoning).toBe("reasoning text")
		expect(result.logs).toEqual(["log1", "log2"])
		expect(result.memorySummary).toBe("memory")
		expect(result.tokensIn).toBe(100)
		expect(result.tokensOut).toBe(200)
		expect(result.cost).toBe(0.05)
		expect(result.pendingTools).toHaveLength(1)
		expect(result.pendingTools?.[0]?.callId).toBe("call-1")
		expect(result.raw).toBe(mcpResult)
	})

	it("should parse fallback format (non-MCP JSON)", () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		const directResult = {
			ok: true,
			status: "done",
			run_id: "run-999",
			text: "direct text",
		}

		const result = adapter.parseResponseBody(directResult)

		expect(result.ok).toBe(true)
		expect(result.runId).toBe("run-999")
		expect(result.text).toBe("direct text")
	})

	it("should return empty string for getEndpoint", () => {
		expect(adapter.getEndpoint("health")).toBe("")
		expect(adapter.getEndpoint("run")).toBe("")
		expect(adapter.getEndpoint("compile")).toBe("")
	})

	it("should return empty object for buildAuthHeaders", () => {
		const profile = createMockProfile()
		adapter.initialize(profile)
		expect(adapter.buildAuthHeaders()).toEqual({})
	})

	it("should callTool correctly", async () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		const result = await adapter.callTool("submit_task", { goal: "test" })

		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const mockClient = vi.mocked(Client).mock.results[0]?.value
		expect(mockClient?.callTool).toHaveBeenCalledWith({
			name: "submit_task",
			arguments: { goal: "test" },
		})
		expect(result.ok).toBe(true)
	})

	it("should auto-connect on first callTool", async () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		// Should not be connected yet
		await adapter.callTool("test_tool", {})

		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
		const mockClient = vi.mocked(Client).mock.results[0]?.value
		expect(mockClient?.connect).toHaveBeenCalled()
	})

	it("should handle tool_calls alias in parseResponseBody", () => {
		const profile = createMockProfile()
		adapter.initialize(profile)

		const mcpResult = {
			content: [{
				type: "text",
				text: JSON.stringify({
					tool_calls: [
						{ call_id: "call-2", tool: "write_file", arguments: { path: "test.txt", content: "hello" } },
					],
				}),
			}],
		}

		const result = adapter.parseResponseBody(mcpResult)
		expect(result.pendingTools).toHaveLength(1)
		expect(result.pendingTools?.[0]?.callId).toBe("call-2")
	})
})
