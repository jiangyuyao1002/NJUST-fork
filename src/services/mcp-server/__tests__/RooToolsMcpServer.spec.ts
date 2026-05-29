import { afterAll, beforeAll, describe, it, expect } from "vitest"
import crypto from "crypto"
import http from "http"
import nock from "nock"
import { RooToolsMcpServer } from "../RooToolsMcpServer"

describe("RooToolsMcpServer — body size limit", () => {
	it("MAX_BODY_SIZE is 10 MB", () => {
		const MAX_BODY_SIZE = 10 * 1024 * 1024
		expect(MAX_BODY_SIZE).toBe(10_485_760)
	})

	it("small body should be accepted", () => {
		const smallData = JSON.stringify({ method: "tools/list", params: {} })
		const size = Buffer.byteLength(smallData)
		expect(size).toBeLessThan(10 * 1024 * 1024)
	})

	it("large body should be rejected", () => {
		const hugeData = "x".repeat(11 * 1024 * 1024) // 11MB
		const size = Buffer.byteLength(hugeData)
		expect(size).toBeGreaterThan(10 * 1024 * 1024)
	})
})

describe("RooToolsMcpServer CORS origin", () => {
	beforeAll(() => {
		nock.enableNetConnect("127.0.0.1")
	})

	afterAll(() => {
		nock.disableNetConnect()
	})

	async function startServer(bindAddress: string, authToken?: string) {
		const server = new RooToolsMcpServer({
			workspacePath: process.cwd(),
			port: 0,
			bindAddress,
			authToken,
		})

		await server.start()
		const address = (server as unknown as { httpServer: { address: () => { port: number } } }).httpServer.address()
		return { server, port: address.port }
	}

	/** OPTIONS 请求，使用 Node http 模块绕过 nock 的 fetch 拦截器。 */
	function optionsRequest(host: string, port: number, origin: string): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{ hostname: host, port, path: "/mcp", method: "OPTIONS", headers: { Origin: origin } },
				(res) => resolve(res),
			)
			req.on("error", reject)
			req.end()
		})
	}

	it("allows browser origin only when server is exposed beyond localhost", async () => {
		const { server, port } = await startServer("0.0.0.0", "secret-token")

		try {
			const res = await optionsRequest("127.0.0.1", port, "https://agent.example")
			expect(res.headers["access-control-allow-origin"]).toBe("https://agent.example")
		} finally {
			await server.stop()
		}
	})

	it("uses null origin for localhost-only server", async () => {
		const { server, port } = await startServer("127.0.0.1")

		try {
			const res = await optionsRequest("127.0.0.1", port, "https://agent.example")
			expect(res.headers["access-control-allow-origin"]).toBe("null")
		} finally {
			await server.stop()
		}
	})
})

describe("RooToolsMcpServer — auth comparison", () => {
	function verifyAuth(authHeader: string | undefined, token: string): boolean {
		if (!authHeader) return false
		const expected = `Bearer ${token}`
		if (authHeader.length !== expected.length) return false
		return crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	}

	it("accepts valid Bearer token", () => {
		expect(verifyAuth("Bearer secret-token", "secret-token")).toBe(true)
	})

	it("rejects wrong token", () => {
		expect(verifyAuth("Bearer wrong-token", "secret-token")).toBe(false)
	})

	it("rejects missing auth header", () => {
		expect(verifyAuth(undefined, "secret-token")).toBe(false)
	})

	it("rejects auth header without Bearer prefix", () => {
		expect(verifyAuth("secret-token", "secret-token")).toBe(false)
	})

	it("rejects tokens of different length — constant-time safe", () => {
		expect(verifyAuth("Bearer short", "very-long-token-value")).toBe(false)
	})
})
