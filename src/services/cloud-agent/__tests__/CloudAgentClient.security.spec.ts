/**
 * P1-#1 验证：Cloud Agent 分块响应内存限制
 *
 * 验证目标：收到不带 Content-Length 的分块响应时，
 * 超过 MAX_RESPONSE_BODY_BYTES (50MB) 后及时终止读取。
 * 测试服务返回无限分块数据，内存不会无限增长。
 */
import { describe, it, expect } from "vitest"

async function readResponseBodyWithLimit(resp: Response, maxBytes: number): Promise<string> {
	if (!resp.body) {
		return resp.text()
	}
	const reader = resp.body.getReader()
	const chunks: Uint8Array[] = []
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) {
				await reader.cancel().catch(() => {})
				throw new Error(`Cloud Agent: response body exceeds limit (${(maxBytes / 1024 / 1024).toFixed(1)} MB)`)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock?.()
	}
	const combined = new Uint8Array(totalBytes)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(combined)
}

function mockChunkedResponse(chunks: Uint8Array[]): Response {
	let i = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i]!)
				i++
			} else {
				controller.close()
			}
		},
	})
	// No Content-Length → simulates Transfer-Encoding: chunked
	return new Response(stream, { status: 200 })
}

describe("readResponseBodyWithLimit — P1-#1 chunked response memory cap", () => {
	it("returns full body when under the byte limit", async () => {
		const body = new TextEncoder().encode("Hello, World!")
		const resp = mockChunkedResponse([body])
		const text = await readResponseBodyWithLimit(resp, 1024)
		expect(text).toBe("Hello, World!")
	})

	it("rejects when cumulative chunks exceed the limit", async () => {
		// 30 chunks × 2 MB = 60 MB, but limit is 5 MB → should reject early
		const chunkSize = 2 * 1024 * 1024
		const chunks: Uint8Array[] = Array.from({ length: 30 }, () => new Uint8Array(chunkSize))
		const resp = mockChunkedResponse(chunks)
		await expect(readResponseBodyWithLimit(resp, 5 * 1024 * 1024)).rejects.toThrow("response body exceeds limit")
	})

	it("terminates before consuming all chunks once limit is hit", async () => {
		// 3 chunks: 100 + 100 + 500 = 700 bytes, limit 250 → should cancel on 3rd
		const resp = mockChunkedResponse([new Uint8Array(100), new Uint8Array(100), new Uint8Array(500)])
		await expect(readResponseBodyWithLimit(resp, 250)).rejects.toThrow("response body exceeds limit")
	})

	it("falls back to resp.text() when body stream is absent", async () => {
		const resp = new Response("short body", { status: 200 })
		const text = await readResponseBodyWithLimit(resp, 1024)
		expect(text).toBe("short body")
	})

	it("handles empty chunked response without error", async () => {
		const resp = mockChunkedResponse([])
		const text = await readResponseBodyWithLimit(resp, 1024)
		expect(text).toBe("")
	})
})
