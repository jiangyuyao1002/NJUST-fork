import { afterEach, describe, expect, it } from "vitest"

import { startMockServer, type MockServerHandle } from "../src/index.js"

describe("MockAPIServer", () => {
	let handle: MockServerHandle | undefined

	afterEach(async () => {
		if (handle) {
			await handle.close()
			handle = undefined
		}
	})

	const start = async (options = {}) => {
		handle = await startMockServer(options)
		return handle
	}

	const readStream = async (response: Response) => {
		return await response.text()
	}

	it("GET /health returns 200 status ok", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/health`)

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ status: "ok" })
	})

	it("POST /v1/chat/completions returns an OpenAI SSE stream", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toContain("text/event-stream")
		expect(body).toContain('"object":"chat.completion.chunk"')
		expect(body).toContain("Mock assistant response.")
		expect(body).toContain("data: [DONE]")
	})

	it("POST /v1/chat/completions returns tool_calls for a tool scenario", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "read-file",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "read file" }] }),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain('"tool_calls"')
		expect(body).toContain('"name":"read_file"')
		expect(body).toContain('"finish_reason":"tool_calls"')
	})

	it("returns multiple OpenAI tool_calls for the multi-tool scenario", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "multi-tool",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "use tools" }] }),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain('"id":"call_read_file"')
		expect(body).toContain('"id":"call_search_files"')
	})

	it("returns final text after tool results are present", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "read-file",
			},
			body: JSON.stringify({
				messages: [
					{ role: "assistant", tool_calls: [{ id: "call_read_file", type: "function" }] },
					{ role: "tool", tool_call_id: "call_read_file", content: "file contents" },
				],
			}),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain("Mock read_file result processed.")
		expect(body).not.toContain('"tool_calls"')
	})

	it("POST /v1/messages returns an Anthropic SSE stream", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain("event: message_start")
		expect(body).toContain("event: content_block_delta")
		expect(body).toContain("Mock assistant response.")
		expect(body).toContain("event: message_stop")
	})

	it("POST /v1/messages returns Anthropic tool_use input_json_delta events", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "read-file",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "read file" }] }),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain('"type":"tool_use"')
		expect(body).toContain('"input":{}')
		expect(body).toContain('"type":"input_json_delta"')
		expect(body).toContain('\\"path\\":\\"src/app.ts\\"')
		expect(body).toContain('"stop_reason":"tool_use"')
	})

	it("unknown scenario returns the default text response", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "does-not-exist",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		})

		expect(await readStream(response)).toContain("Mock assistant response.")
	})

	it("selects scenario from the request body", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mock_scenario: "execute-command",
				messages: [{ role: "user", content: "run command" }],
			}),
		})
		const body = await readStream(response)

		expect(response.status).toBe(200)
		expect(body).toContain('"name":"execute_command"')
	})

	it("returns HTTP 500 for the error scenario", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-mock-scenario": "error",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "fail" }] }),
		})

		expect(response.status).toBe(500)
		await expect(response.json()).resolves.toEqual({
			error: {
				message: "Mock API error",
				type: "mock_api_error",
			},
		})
	})

	it("returns 404 for unknown routes", async () => {
		const server = await start()

		const response = await fetch(`${server.url}/missing`)

		expect(response.status).toBe(404)
		await expect(response.json()).resolves.toEqual({ error: "not_found" })
	})

	it("starts on a requested port", async () => {
		const first = await start()
		const requestedPort = first.port
		await first.close()
		handle = undefined

		const server = await start({ port: requestedPort })

		expect(server.port).toBe(requestedPort)
	})

	it("rejects request bodies over the configured size limit", async () => {
		const server = await start({ maxBodyBytes: 10 })

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "this body is too large" }] }),
		})

		expect(response.status).toBe(413)
		await expect(response.json()).resolves.toEqual({ error: "Request body too large" })
	})

	it("supports configurable response delay", async () => {
		const server = await start({ responseDelayMs: 5 })
		const startedAt = Date.now()

		const response = await fetch(`${server.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
		})
		await readStream(response)

		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10)
	})
})
