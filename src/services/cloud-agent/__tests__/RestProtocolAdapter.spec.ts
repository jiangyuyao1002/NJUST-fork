import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { RestProtocolAdapter } from "../adapters/RestProtocolAdapter"
import type { CloudAgentProfile } from "../../types/profile"
import { setDeviceToken } from "../deviceToken"

function createMockProfile(overrides?: Partial<CloudAgentProfile>): CloudAgentProfile {
	return {
		id: "test-profile",
		name: "Test Profile",
		protocolType: "rest",
		serverUrl: "http://localhost:8765",
		auth: { type: "api-key", apiKey: "secret-key", deviceTokenSource: "global" },
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as CloudAgentProfile
}

describe("RestProtocolAdapter", () => {
	beforeEach(() => {
		setDeviceToken("test-device-token")
	})

	afterEach(() => {
		setDeviceToken("")
	})

	describe("buildAuthHeaders()", () => {
		it("includes X-API-Key for api-key auth", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-API-Key"]).toBe("secret-key")
			expect(headers["X-Device-Token"]).toBe("test-device-token")
		})

		it("includes X-Device-Token for device-token auth when token exists", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "device-token", deviceTokenSource: "global" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-Device-Token"]).toBe("test-device-token")
			expect(headers["X-API-Key"]).toBeUndefined()
		})

		it("omits X-Device-Token when deviceToken is empty (missing deviceToken scenario)", () => {
			setDeviceToken("") // 模拟 device token 缺失
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "device-token", deviceTokenSource: "global" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-Device-Token"]).toBeUndefined()
			expect(Object.keys(headers)).toHaveLength(0)
		})

		it("uses profile deviceToken when deviceTokenSource is 'profile'", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "device-token", deviceTokenSource: "profile", deviceToken: "profile-specific-token" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-Device-Token"]).toBe("profile-specific-token")
		})

		it("falls back to global deviceToken when profile deviceToken is empty", () => {
			setDeviceToken("global-token")
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "device-token", deviceTokenSource: "profile", deviceToken: "" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-Device-Token"]).toBe("global-token")
		})

		it("includes Authorization Bearer for bearer auth", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "bearer", bearerToken: "my-bearer-token" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["Authorization"]).toBe("Bearer my-bearer-token")
		})

		it("includes Authorization Basic for basic auth", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "basic", basicUsername: "user", basicPassword: "pass" },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["Authorization"]).toBe("Basic " + Buffer.from("user:pass").toString("base64"))
		})

		it("includes custom headers for custom auth", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(
				createMockProfile({
					auth: { type: "custom", customHeaders: { "X-Custom": "value" } },
				}),
			)
			const headers = adapter.buildAuthHeaders()
			expect(headers["X-Custom"]).toBe("value")
		})
	})

	describe("buildRequestBody()", () => {
		it("builds correct request body with all fields", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const body = adapter.buildRequestBody({
				goal: "test goal",
				sessionId: "session-123",
				workspacePath: "/workspace",
				images: ["img1", "img2"],
				runId: "run-456",
				toolResults: [{ call_id: "c1", content: "ok", is_error: false }],
			})
			expect(body).toMatchObject({
				goal: "test goal",
				session_id: "session-123",
				workspace_path: "/workspace",
				images: ["img1", "img2"],
				run_id: "run-456",
				tool_results: [{ call_id: "c1", content: "ok", is_error: false }],
			})
		})

		it("omits optional fields when not provided", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const body = adapter.buildRequestBody({
				goal: "simple goal",
				sessionId: "session-123",
			})
			expect(body).toMatchObject({
				goal: "simple goal",
				session_id: "session-123",
			})
			expect(body).not.toHaveProperty("workspace_path")
			expect(body).not.toHaveProperty("images")
			expect(body).not.toHaveProperty("run_id")
			expect(body).not.toHaveProperty("tool_results")
		})
	})

	describe("parseResponseBody()", () => {
		it("parses /v1/run response (no run_id)", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const response = adapter.parseResponseBody({
				ok: true,
				memory_summary: "done",
				logs: ["log1"],
				tokens_in: 10,
				tokens_out: 20,
				cost: 0.01,
			})
			expect(response.runId).toBe("")
			expect(response.status).toBe("done")
			expect(response.ok).toBe(true)
			expect(response.memorySummary).toBe("done")
			expect(response.logs).toEqual(["log1"])
			expect(response.tokensIn).toBe(10)
			expect(response.tokensOut).toBe(20)
			expect(response.cost).toBe(0.01)
		})

		it("parses deferred response (with run_id)", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const response = adapter.parseResponseBody({
				run_id: "run-123",
				status: "pending",
				pending_tools: [{ call_id: "c1", tool: "read_file", arguments: { path: "a.ts" } }],
				text: "working",
			})
			expect(response.runId).toBe("run-123")
			expect(response.status).toBe("pending")
			expect(response.pendingTools).toHaveLength(1)
			expect(response.pendingTools?.[0].callId).toBe("c1")
			expect(response.text).toBe("working")
		})

		it("normalizes tool_calls to pendingTools", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			const response = adapter.parseResponseBody({
				run_id: "run-123",
				status: "pending",
				tool_calls: [{ id: "tc1", name: "write_file", arguments: '{"path":"a.ts"}' }],
			})
			expect(response.pendingTools).toHaveLength(1)
			expect(response.pendingTools?.[0].callId).toBe("tc1")
		})
	})

	describe("getEndpoint()", () => {
		it("returns correct endpoints", () => {
			const adapter = new RestProtocolAdapter()
			adapter.initialize(createMockProfile())
			expect(adapter.getEndpoint("health")).toBe("/health")
			expect(adapter.getEndpoint("run")).toBe("/v1/run")
			expect(adapter.getEndpoint("deferredStart")).toBe("/v1/run/deferred/start")
			expect(adapter.getEndpoint("deferredResume")).toBe("/v1/run/deferred/resume")
			expect(adapter.getEndpoint("deferredAbort")).toBe("/v1/run/deferred/abort")
			expect(adapter.getEndpoint("compile")).toBe("/v1/run/compile")
		})
	})
})
