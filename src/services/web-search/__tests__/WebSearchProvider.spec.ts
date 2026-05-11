import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
	DuckDuckGoSearchProvider,
	BaiduFreeSearchProvider,
	SogouFreeSearchProvider,
} from "../WebSearchProvider"

vi.mock("../../../core/security/networkGuard", () => ({
	guardedFetch: vi.fn(),
}))

describe("WebSearchProvider ReDoS hardening", () => {
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		vi.restoreAllMocks()
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	describe("HTML truncation (T015)", () => {
		it("DuckDuckGo truncates HTML to 500KB before parsing", async () => {
			const beforeMarker =
				'<a rel="nofollow" href="https://example.com/visible" class="result-link">Visible Result</a>' +
				'<td class="result-snippet">Visible snippet</td>'
			const padding = "<div>" + "x".repeat(500_001) + "</div>"
			const afterMarker =
				'<a rel="nofollow" href="https://example.com/hidden" class="result-link">Hidden After 500KB</a>' +
				'<td class="result-snippet">Hidden snippet</td>'
			const html = beforeMarker + padding + afterMarker

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: () => Promise.resolve(html),
				headers: new Headers(),
			} as Response)

			const provider = new DuckDuckGoSearchProvider()
			const results = await provider.search("test", 10)

			expect(results.find((r) => r.title === "Visible Result")).toBeDefined()
			expect(results.find((r) => r.title === "Hidden After 500KB")).toBeUndefined()
		})

		it("Baidu truncates HTML to 500KB before parsing", async () => {
			const beforeMarker =
				'<h3><a href="https://www.baidu.com/link?url=visible123" target="_blank">Visible Result</a></h3>'
			const afterMarker =
				'<h3><a href="https://www.baidu.com/link?url=hidden456" target="_blank">Hidden After 500KB</a></h3>'
			const padding = "<div>" + "x".repeat(500_001) + "</div>"
			const html = beforeMarker + padding + afterMarker

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: () => Promise.resolve(html),
				headers: new Headers(),
			} as Response)

			const provider = new BaiduFreeSearchProvider()
			const results = await provider.search("test", 10)

			expect(results.find((r) => r.title === "Visible Result")).toBeDefined()
			expect(results.find((r) => r.title === "Hidden After 500KB")).toBeUndefined()
		})

		it("Sogou truncates HTML to 500KB before parsing", async () => {
			const afterMarker =
				'<h3><a href="https://example.com/hidden">Hidden After 500KB</a></h3>'
			const padding = "<div>" + "x".repeat(500_001) + "</div>"
			const html = padding + afterMarker

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: () => Promise.resolve(html),
				headers: new Headers(),
				[Symbol.iterator]: (() => {
					const h = new Headers()
					return h[Symbol.iterator].bind(h)
				})(),
			} as unknown as Response)

			const provider = new SogouFreeSearchProvider()
			const results = await provider.search("test", 10)

			expect(results.find((r) => r.title === "Hidden After 500KB")).toBeUndefined()
		})
	})

	describe("DDG iteration limit (T017)", () => {
		it("DuckDuckGo caps link and snippet iteration at 100", async () => {
			// Generate HTML with 200+ matching links and snippets
			const links: string[] = []
			const snippets: string[] = []
			for (let i = 0; i < 200; i++) {
				links.push('<a rel="nofollow" href="https://example.com/' + i + '" class="result-link">Result ' + i + '</a>')
				snippets.push('<td class="result-snippet">Snippet ' + i + '</td>')
			}
			const html = links.join('') + snippets.join('')

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: () => Promise.resolve(html),
				headers: new Headers(),
			} as Response)

			const provider = new DuckDuckGoSearchProvider()
			const results = await provider.search("test", 200)

			// Without iteration limit, results would have up to 200 items
			// With limit, links array is capped at 100, so at most 100 results
			expect(results.length).toBeLessThanOrEqual(100)
		})
	})
})
