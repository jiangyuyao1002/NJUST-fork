import { afterEach, describe, expect, it, vi } from "vitest"

import { CloudAgentClient } from "../CloudAgentClient"

describe("CloudAgentClient", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
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
		const client = new CloudAgentClient("http://localhost:8765", "device-token", callbacks, {
			apiKey: "secret-key",
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

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
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

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
		await client.connect()
		const result = await client.submitTask("s", "m")

		expect(result.workspaceOps).toEqual([])
		expect(result.workspaceOpsParseError).toBeDefined()
	})

	it("omits X-API-Key when apiKey option is unset", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValue(new Response("", { status: 200 }))

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
		await client.connect()

		const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers as HeadersInit)
		expect(headers.has("X-API-Key")).toBe(false)
	})

	it("enriches connect() error when fetch fails with a cause (e.g. ECONNREFUSED)", async () => {
		const fetchMock = vi.fn().mockRejectedValue(
			Object.assign(new Error("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			}),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
		await expect(client.connect()).rejects.toThrow(/fetch failed.*ECONNREFUSED|connect ECONNREFUSED/)
	}, 15_000)

	it("throws on non-OK HTTP for submitTask", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 502 })))

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
		await client.connect()
		await expect(client.submitTask("s", "m")).rejects.toThrow("Cloud Agent error (HTTP 502)")
	}, 15_000)

	it("throws when response body is not JSON", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch
		fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }))
		fetchMock.mockImplementation(() => Promise.resolve(new Response("not-json", { status: 200 })))

		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks())
		await client.connect()
		await expect(client.submitTask("s", "m")).rejects.toThrow("not valid JSON")
	}, 15_000)

	it("aborts connect when signal is already aborted", async () => {
		const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
			if (init?.signal?.aborted) {
				return Promise.reject(new DOMException("Aborted", "AbortError"))
			}
			return Promise.resolve(new Response("", { status: 200 }))
		})
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const ac = new AbortController()
		ac.abort()
		const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks(), { signal: ac.signal })

		await expect(client.connect()).rejects.toMatchObject({ name: "AbortError" })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it(
		"times out when requestTimeoutMs elapses",
		async () => {
			const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
				return new Promise<Response>((resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"))
					})
				})
			})
			globalThis.fetch = fetchMock as unknown as typeof fetch

			const client = new CloudAgentClient("http://localhost:8765", "tok", createCallbacks(), {
				requestTimeoutMs: 40,
			})

			await expect(client.connect()).rejects.toMatchObject({ name: "AbortError" })
		},
		10_000,
	)
})
