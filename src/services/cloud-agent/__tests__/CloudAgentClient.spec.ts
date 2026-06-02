import { afterEach, describe, expect, it, vi } from "vitest"

import { CloudAgentClient } from "../CloudAgentClient"
import type { CloudAgentProfile } from "../types/profile"
import { setDeviceToken } from "../deviceToken"
import { AdapterFactory } from "../adapters/AdapterFactory"

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
	}
}

// 设置测试用的 device token
setDeviceToken("device-token")

describe("CloudAgentClient", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	function createCallbacks() {
		return {
			onText: vi.fn().mockResolvedValue(undefined),
			onReasoning: vi.fn().mockResolvedValue(undefined),
			onDone: vi.fn().mockResolvedValue(undefined),
			onError: vi.fn().mockResolvedValue(undefined),
		}
	}

	it("connects, submits task, streams logs and summary, returns usage", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					user_goal: "do thing",
					memory_summary: "done",
					logs: ["log1", "log2"],
					tokens_in: 11,
					tokens_out: 22,
					cost: 0.05,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		)

		const callbacks = createCallbacks()
		const client = new CloudAgentClient(callbacks, {
			profile: createMockProfile(),
		})

		await client.connect()
		const result = await client.submitTask("sid-1", "hello", "/ws", ["img-a"])

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const healthInit = fetchMock.mock.calls[0][1] as RequestInit
		expect(healthInit.method).toBe("GET")
		const healthHeaders = new Headers(healthInit.headers as HeadersInit)
		expect(healthHeaders.get("X-Device-Token")).toBe("device-token")
		expect(healthHeaders.get("X-API-Key")).toBe("secret-key")

		const runInit = fetchMock.mock.calls[1][1] as RequestInit
		expect(runInit.method).toBe("POST")
		const body = JSON.parse(runInit.body as string)
		expect(body).toMatchObject({
			goal: "hello",
			session_id: "sid-1",
			workspace_path: "/ws",
			images: ["img-a"],
		})

		expect(callbacks.onText).toHaveBeenCalledWith("log1")
		expect(callbacks.onText).toHaveBeenCalledWith("log2")
		expect(callbacks.onText).toHaveBeenCalledWith("done")
		expect(callbacks.onDone).toHaveBeenCalledWith("Task completed")

		expect(result).toMatchObject({
			memorySummary: "done",
			tokensIn: 11,
			tokensOut: 22,
			cost: 0.05,
			workspaceOps: [],
		})
		expect(result.workspaceOpsParseError).toBeUndefined()
	})

	it("returns parsed workspace_ops from response", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					user_goal: "g",
					memory_summary: "s",
					logs: [],
					workspace_ops: {
						version: 1,
						operations: [{ op: "write_file", path: "note.md", content: "x" }],
					},
				}),
				{ status: 200 },
			),
		)

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		await client.connect()
		const result = await client.submitTask("s", "m")

		expect(result.workspaceOps).toEqual([{ op: "write_file", path: "note.md", content: "x" }])
		expect(result.workspaceOpsParseError).toBeUndefined()
	})

	it("returns workspaceOpsParseError when workspace_ops fails validation", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					ok: true,
					user_goal: "g",
					memory_summary: "s",
					logs: [],
					workspace_ops: { version: 2, operations: [] },
				}),
				{ status: 200 },
			),
		)

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		await client.connect()
		const result = await client.submitTask("s", "m")

		expect(result.workspaceOps).toEqual([])
		expect(result.workspaceOpsParseError).toBeDefined()
	})

	it("omits X-API-Key when apiKey option is unset", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValue(new Response("", { status: 200 }))

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile({ auth: { type: "device-token", deviceTokenSource: "global" } }),
		})
		await client.connect()

		const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit)
		expect(headers.has("X-API-Key")).toBe(false)
	})

	it("omits X-Device-Token when deviceToken is empty", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValue(new Response("", { status: 200 }))

		// 清空 device token
		setDeviceToken("")
		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile({ auth: { type: "device-token", deviceTokenSource: "global" } }),
		})
		await client.connect()

		const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit)
		expect(headers.has("X-Device-Token")).toBe(false)

		// 恢复 device token
		setDeviceToken("device-token")
	})

	it("enriches connect() error when fetch fails with a cause (e.g. ECONNREFUSED)", async () => {
		const fetchMock = vi.fn().mockRejectedValue(
			Object.assign(new Error("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			}),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		await expect(client.connect()).rejects.toThrow(/fetch failed.*ECONNREFUSED|connect ECONNREFUSED/)
	}, 15_000)

	it("throws on non-OK HTTP for submitTask", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 502 })))

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		await client.connect()
		await expect(client.submitTask("s", "m")).rejects.toThrow("Cloud Agent error (HTTP 502)")
	}, 15_000)

	it("retries submitTask after a transient 5xx response", async () => {
		vi.useFakeTimers()
		vi.spyOn(Math, "random").mockReturnValue(0.5)

		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 502 }))
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true, logs: [], memory_summary: "" }), { status: 200 }),
		)

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		const resultPromise = client.submitTask("s", "m")

		await vi.advanceTimersByTimeAsync(2_000)
		await expect(resultPromise).resolves.toMatchObject({ memorySummary: "" })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	}, 10_000)

	it("does not retry submitTask on auth failures", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})

		await expect(client.submitTask("s", "m")).rejects.toThrow("HTTP 401")
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("throws when response body is not JSON", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockImplementation(() => Promise.resolve(new Response("not-json", { status: 200 })))

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
		})
		await client.connect()
		await expect(client.submitTask("s", "m")).rejects.toThrow("not valid JSON")
	}, 15_000)

	it("aborts connect when signal is already aborted", async () => {
		const fetchMock = vi.fn(function (_url: string | URL, init?: RequestInit) {
			if (init?.signal?.aborted) {
				return Promise.reject(new DOMException("Aborted", "AbortError"))
			}
			return Promise.resolve(new Response("", { status: 200 }))
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const ac = new AbortController()
		ac.abort()
		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
			signal: ac.signal,
		})

		await expect(client.connect()).rejects.toMatchObject({ name: "AbortError" })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it("times out when requestTimeoutMs elapses", async () => {
		const fetchMock = vi.fn(function (_url: string | URL, init?: RequestInit) {
			return new Promise<Response>((resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("Aborted", "AbortError"))
				})
			})
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const client = new CloudAgentClient(createCallbacks(), {
			profile: createMockProfile(),
			requestTimeoutMs: 40,
		})

		await expect(client.connect()).rejects.toMatchObject({ name: "AbortError" })
	}, 10_000)

	describe("constructor HTTPS enforcement", () => {
		it("rejects non-localhost HTTP", () => {
			expect(
				() =>
					new CloudAgentClient(createCallbacks(), {
						profile: createMockProfile({ serverUrl: "http://evil.com" }),
					}),
			).toThrow("requires HTTPS")
		})

		it("accepts localhost HTTP", () => {
			expect(
				() =>
					new CloudAgentClient(createCallbacks(), {
						profile: createMockProfile({ serverUrl: "http://localhost:3000" }),
					}),
			).not.toThrow()
		})

		it("accepts 127.0.0.1 HTTP", () => {
			expect(
				() =>
					new CloudAgentClient(createCallbacks(), {
						profile: createMockProfile({ serverUrl: "http://127.0.0.1:4000" }),
					}),
			).not.toThrow()
		})

		it("accepts HTTPS", () => {
			expect(
				() =>
					new CloudAgentClient(createCallbacks(), {
						profile: createMockProfile({ serverUrl: "https://api.example.com" }),
					}),
			).not.toThrow()
		})
	})

	describe("compile", () => {
		it("returns success result", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({ success: true, output: "" }), { status: 200 }))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			const result = await client.compile("sid-1", "/ws")

			expect(result.success).toBe(true)
			expect(result.output).toBe("")
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
			expect(body).toMatchObject({ session_id: "sid-1", workspace_path: "/ws" })
		})

		it("returns failure with compile errors", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ success: false, output: "error: line 5" }), { status: 200 }),
				)
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			const result = await client.compile("sid-1")

			expect(result.success).toBe(false)
			expect(result.output).toContain("error: line 5")
		})

		it("throws on non-OK HTTP", async () => {
			let callCount = 0
			const fetchMock = vi.fn(function () {
				callCount++
				return Promise.resolve(new Response("internal error", { status: 500 }))
			})
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			await expect(client.compile("sid-1")).rejects.toThrow("compile error")
			expect(callCount).toBeGreaterThanOrEqual(1)
		}, 15_000)
	})

	describe("deferred protocol", () => {
		it("deferredStart sends to correct endpoint with images", async () => {
			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						run_id: "run-1",
						status: "pending",
						pending_tools: [{ call_id: "c1", tool: "read_file", arguments: { path: "a.ts" } }],
					}),
					{ status: 200 },
				),
			)
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			const result = await client.deferredStart("sid-1", "goal", "/ws", ["img"])

			expect(result.run_id).toBe("run-1")
			expect(result.status).toBe("pending")
			expect(result.pending_tools!.length).toBe(1)

			const url = fetchMock.mock.calls[0][0] as string
			expect(url).toContain("/v1/run/deferred/start")
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
			expect(body).toMatchObject({ goal: "goal", session_id: "sid-1", workspace_path: "/ws", images: ["img"] })
		})

		it("deferredStart returns done status", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ run_id: "run-2", status: "done", ok: true }), { status: 200 }),
				)
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			const result = await client.deferredStart("sid-1", "goal")

			expect(result.status).toBe("done")
		})

		it("deferredResume sends tool results", async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ run_id: "run-1", status: "done", ok: true }), { status: 200 }),
				)
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			const toolResults = [{ call_id: "c1", content: "file content", is_error: false }]
			const result = await client.deferredResume("run-1", "sid-1", toolResults)

			expect(result.status).toBe("done")
			const url = fetchMock.mock.calls[0][0] as string
			expect(url).toContain("/v1/run/deferred/resume")
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
			expect(body).toMatchObject({ run_id: "run-1", session_id: "sid-1", tool_results: toolResults })
		})
	})

	describe("sendDeferredAbort (static)", () => {
		it("handles 404 gracefully (older servers)", async () => {
			const fetchMock = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			await CloudAgentClient.sendDeferredAbort(createMockProfile({ serverUrl: "http://localhost:4000" }), "sid-1")
		})

		it("sends correct body with runId", async () => {
			const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			await CloudAgentClient.sendDeferredAbort(
				createMockProfile({ serverUrl: "http://localhost:4000" }),
				"sid-1",
				"run-1",
			)

			const url = fetchMock.mock.calls[0][0] as string
			expect(url).toContain("/v1/run/deferred/abort")
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
			expect(body).toMatchObject({ session_id: "sid-1", run_id: "run-1" })
			const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit)
			expect(headers.get("X-API-Key")).toBe("secret-key")
		})
	})

	describe("disconnect", () => {
		it("calls sendDeferredAbort with correct params", async () => {
			const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			await client.disconnect("sid-1", "run-1")

			expect(fetchMock).toHaveBeenCalledTimes(1)
			const url = fetchMock.mock.calls[0][0] as string
			expect(url).toContain("/v1/run/deferred/abort")
		})

		it("does nothing when sessionId is empty", async () => {
			const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }))
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ serverUrl: "http://localhost:4000" }),
			})
			await client.disconnect("", "run-1")

			expect(fetchMock).not.toHaveBeenCalled()
		})
	})

	describe("MCP protocol path", () => {
		function createMcpMockAdapter() {
			return {
				protocolType: "mcp" as const,
				setCallbackHandler: vi.fn(),
				initialize: vi.fn(),
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				buildRequestBody: vi.fn().mockReturnValue({ goal: "test", session_id: "sid" }),
				parseResponseBody: vi.fn().mockReturnValue({
					runId: "run-123",
					status: "done" as const,
					ok: true,
					text: "result",
					logs: [],
					memorySummary: "summary",
					tokensIn: 10,
					tokensOut: 20,
					cost: 0,
					raw: {},
				}),
				getEndpoint: vi.fn().mockReturnValue(""),
				buildAuthHeaders: vi.fn().mockReturnValue({}),
				callTool: vi.fn().mockResolvedValue({
					runId: "run-123",
					status: "done" as const,
					ok: true,
					text: "result",
					memorySummary: "summary",
					logs: [],
					tokensIn: 10,
					tokensOut: 20,
					cost: 0,
					raw: {},
				}),
				parseCompileResponse: vi.fn().mockReturnValue({ success: true, output: "OK" }),
			}
		}

		it("should call adapter.connect() for MCP protocol", async () => {
			const mockAdapter = createMcpMockAdapter()
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)
			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
			})
			await client.connect()
			expect(mockAdapter.connect).toHaveBeenCalled()
		})

		it("should call adapter.disconnect() for MCP protocol", async () => {
			const mockAdapter = createMcpMockAdapter()
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)
			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
			})
			await client.disconnect("session-123")
			expect(mockAdapter.disconnect).toHaveBeenCalled()
		})

		it("should call callTool for submitTask MCP path", async () => {
			const mockAdapter = createMcpMockAdapter()
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)
			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
			})
			const result = await client.submitTask("session-123", "test message")
			expect(mockAdapter.callTool).toHaveBeenCalledWith("submit_task", expect.any(Object))
			expect(result.memorySummary).toBe("summary")
		})

		it("should call callTool and parseCompileResponse for compile MCP path", async () => {
			const mockAdapter = createMcpMockAdapter()
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)
			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
			})
			const result = await client.compile("session-123")
			expect(mockAdapter.callTool).toHaveBeenCalledWith("compile", expect.any(Object))
			expect(mockAdapter.parseCompileResponse).toHaveBeenCalled()
			expect(result.success).toBe(true)
			expect(result.output).toBe("OK")
		})

		it("should abort MCP connect when signal is already aborted", async () => {
			const mockAdapter = createMcpMockAdapter()
			mockAdapter.connect.mockImplementation(() => new Promise(() => {}))
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)

			const abortController = new AbortController()
			abortController.abort()

			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
				signal: abortController.signal,
			})

			await expect(client.connect()).rejects.toThrow()
		})

		it("should handle MCP callTool failure in withMcpAdapter", async () => {
			const mockAdapter = createMcpMockAdapter()
			mockAdapter.callTool.mockRejectedValue(new Error("MCP call failed"))
			vi.spyOn(AdapterFactory, "create").mockReturnValue(mockAdapter as UnsafeAny)
			const client = new CloudAgentClient(createCallbacks(), {
				profile: createMockProfile({ protocolType: "mcp" }),
			})
			await expect(client.submitTask("session-123", "test")).rejects.toThrow("MCP call failed")
			expect(mockAdapter.disconnect).toHaveBeenCalled()
		})
	})
})
