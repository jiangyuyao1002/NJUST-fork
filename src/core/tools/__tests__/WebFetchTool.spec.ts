import { beforeEach, describe, expect, it, vi } from "vitest"

const { axiosGetMock, axiosIsAxiosErrorMock, dnsLookupMock, assertSafeOutboundUrlMock, assertPublicIpMock } =
	vi.hoisted(() => ({
		axiosGetMock: vi.fn(),
		axiosIsAxiosErrorMock: vi.fn(),
		dnsLookupMock: vi.fn(),
		assertSafeOutboundUrlMock: vi.fn(),
		assertPublicIpMock: vi.fn(),
	}))

vi.mock("axios", () => ({
	default: {
		get: axiosGetMock,
		isAxiosError: axiosIsAxiosErrorMock,
	},
}))

vi.mock("node:dns/promises", () => ({
	default: {
		lookup: dnsLookupMock,
	},
	lookup: dnsLookupMock,
}))

vi.mock("../../security/networkGuard", () => ({
	assertSafeOutboundUrl: assertSafeOutboundUrlMock,
	assertPublicIp: assertPublicIpMock,
}))

import { webFetchTool } from "../WebFetchTool"

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		reportProgress: vi.fn(),
	}
}

describe("webFetchTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		axiosIsAxiosErrorMock.mockReturnValue(false)
		assertSafeOutboundUrlMock.mockImplementation(async (url: string) => new URL(url))
		dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34" }])
		axiosGetMock.mockResolvedValue({ data: "<html><body>Hello</body></html>" })
	})

	it("exposes read-only eager metadata", () => {
		expect(webFetchTool.isReadOnly()).toBe(true)
		expect(webFetchTool.isConcurrencySafe()).toBe(true)
		expect(webFetchTool.getEagerExecutionDecision()).toBe("eager")
		expect(webFetchTool.userFacingName()).toBe("Web Fetch")
		expect(webFetchTool.searchHint).toContain("web fetch")
	})

	it("accepts stable http and https partial urls only", () => {
		expect(webFetchTool.isPartialArgsStable({ url: "https://example.com" })).toBe(true)
		expect(webFetchTool.isPartialArgsStable({ url: "http://example.com" })).toBe(true)
		expect(webFetchTool.isPartialArgsStable({ url: "ftp://example.com" })).toBe(false)
		expect(webFetchTool.isPartialArgsStable({ url: "" })).toBe(false)
		expect(webFetchTool.isPartialArgsStable({ url: "not url" })).toBe(false)
	})

	it("reports unsafe urls before approval", async () => {
		assertSafeOutboundUrlMock.mockRejectedValueOnce(new Error("Blocked private host"))
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "http://127.0.0.1" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Blocked private host"))
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("returns a user cancellation message when approval is denied", async () => {
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValueOnce(false)

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Web fetch was not approved by the user.")
		expect(axiosGetMock).not.toHaveBeenCalled()
	})

	it("fetches html as collapsed body text by default", async () => {
		axiosGetMock.mockResolvedValueOnce({
			data: "<html><body>Hello <script>bad()</script>\n <strong>World</strong></body></html>",
		})
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.reportProgress).toHaveBeenCalledWith({ icon: "globe", text: "Fetching https://example.com" })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Hello World")
	})

	it("returns raw html when requested", async () => {
		axiosGetMock.mockResolvedValueOnce({ data: "<main>Raw</main>" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com", format: "html" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("<main>Raw</main>")
	})

	it("stringifies json response data", async () => {
		axiosGetMock.mockResolvedValueOnce({ data: { ok: true, count: 2 } })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com/data", format: "json" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith('{\n  "ok": true,\n  "count": 2\n}')
	})

	it("converts html body to markdown", async () => {
		axiosGetMock.mockResolvedValueOnce({ data: "<body><h1>Title</h1><p>Hello</p><script>bad()</script></body>" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com", format: "markdown" }, {} as any, callbacks as any)

		const output = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(output).toContain("# Title")
		expect(output).toContain("Hello")
		expect(output).not.toContain("bad()")
	})

	it("truncates long output at maxLength", async () => {
		axiosGetMock.mockResolvedValueOnce({ data: "<body>abcdef</body>" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com", maxLength: 3 }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("abc\n\n[Truncated: content exceeded 3 characters]")
	})

	it("skips dns lookup for literal IP hosts", async () => {
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://93.184.216.34" }, {} as any, callbacks as any)

		expect(dnsLookupMock).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Hello")
	})

	it("pins to resolved IP to prevent DNS rebinding", async () => {
		dnsLookupMock.mockResolvedValueOnce([{ address: "93.184.216.34" }])
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		// IP pinning: one DNS call, no post-request comparison needed
		expect(dnsLookupMock).toHaveBeenCalledTimes(1)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Hello")
	})

	it("formats axios errors as tool errors", async () => {
		const error = Object.assign(new Error("Request failed"), {
			response: { status: 500, statusText: "Server Error" },
		})
		axiosGetMock.mockRejectedValueOnce(error)
		axiosIsAxiosErrorMock.mockReturnValueOnce(true)
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("HTTP request failed (500 Server Error)"),
		)
	})

	it("delegates non-axios errors to handleError", async () => {
		axiosGetMock.mockRejectedValueOnce(new Error("boom"))
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.handleError).toHaveBeenCalledWith("web fetch", expect.objectContaining({ message: "boom" }))
	})
})

describe("webFetchTool > manual redirect loop", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		axiosIsAxiosErrorMock.mockReturnValue(false)
		assertSafeOutboundUrlMock.mockImplementation(async (url: string) => new URL(url))
		dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34" }])
	})

	it("follows safe redirect within limit", async () => {
		axiosGetMock
			.mockResolvedValueOnce({ status: 302, headers: { location: "https://safe-target.com/page" }, data: "" })
			.mockResolvedValueOnce({ status: 200, headers: {}, data: "<html><body>Final</body></html>" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com/start" }, {} as any, callbacks as any)

		expect(assertSafeOutboundUrlMock).toHaveBeenCalledTimes(2)
		expect(assertSafeOutboundUrlMock).toHaveBeenNthCalledWith(1, "https://example.com/start")
		expect(assertSafeOutboundUrlMock).toHaveBeenNthCalledWith(2, "https://safe-target.com/page")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Final")
	})

	it("resolves relative redirect URL", async () => {
		axiosGetMock
			.mockResolvedValueOnce({ status: 302, headers: { location: "/relative-path" }, data: "" })
			.mockResolvedValueOnce({ status: 200, headers: {}, data: "relative content" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com/base" }, {} as any, callbacks as any)

		expect(assertSafeOutboundUrlMock).toHaveBeenNthCalledWith(2, "https://example.com/relative-path")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("relative content")
	})

	it("blocks redirect to private IP (SSRF)", async () => {
		assertSafeOutboundUrlMock
			.mockResolvedValueOnce(new URL("https://example.com"))
			.mockRejectedValueOnce(new Error("Blocked private IP: 127.0.0.1"))
		axiosGetMock.mockResolvedValueOnce({ status: 302, headers: { location: "http://127.0.0.1/secret" }, data: "" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.handleError).toHaveBeenCalledWith(
			"web fetch",
			expect.objectContaining({ message: expect.stringContaining("Blocked private IP") }),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("stops after max redirects", async () => {
		// Provide 6 redirects; loop should execute 6 requests then break
		// (5 redirects following + 1 more that triggers redirectCount >= MAX check)
		for (let i = 0; i < 6; i++) {
			axiosGetMock.mockResolvedValueOnce({
				status: 302,
				headers: { location: `https://example.com/step${i + 1}` },
				data: "",
			})
		}
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		// 5 redirects followed by 1 final request that detects redirectCount limit
		expect(axiosGetMock).toHaveBeenCalledTimes(6)
	})

	it("no redirect returns normally", async () => {
		axiosGetMock.mockResolvedValueOnce({ status: 200, headers: {}, data: "<html><body>OK</body></html>" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith("OK")
		expect(assertSafeOutboundUrlMock).toHaveBeenCalledTimes(1)
	})

	it("missing location header breaks loop", async () => {
		axiosGetMock.mockResolvedValueOnce({ status: 302, headers: {}, data: "no-location" })
		const callbacks = createCallbacks()

		await webFetchTool.execute({ url: "https://example.com" }, {} as any, callbacks as any)

		// No Location header → break → pushes the 302 response as result
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("no-location")
	})
})
