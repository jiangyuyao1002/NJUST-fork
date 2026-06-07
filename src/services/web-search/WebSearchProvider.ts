import { guardedFetch } from "../../core/security/networkGuard"
import { getErrorMessage } from "../../shared/error-utils"
import { t } from "../../i18n"

export type WebSearchProviderName =
	| "tavily"
	| "bing"
	| "google"
	| "baidu"
	| "serpapi"
	| "duckduckgo"
	| "baidu-free"
	| "sogou-free"

export interface WebSearchResult {
	title: string
	url: string
	snippet: string
}

export interface WebSearchProvider {
	search(query: string, count: number): Promise<WebSearchResult[]>
}

function makeAbortController(timeoutMs = 15_000) {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
	return { controller, clear: () => clearTimeout(timeoutId) }
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
	return guardedFetch(url, init)
}

/** Undici/Node often surfaces low-level errors as `fetch failed` with `error.cause`. */
function formatFetchFailureMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error)
	}
	const parts = [error.message]
	const c = (error as Error & { cause?: unknown }).cause
	if (c instanceof Error && c.message && !error.message.includes(c.message)) {
		parts.push(`(${c.message})`)
	} else if (typeof c === "object" && c !== null && "code" in c) {
		parts.push(`(code: ${String((c as { code?: unknown }).code)})`)
	}
	return parts.join(" ")
}

/** Node/undici exposes multiple Set-Cookie via getSetCookie(); use for Sogou session warm-up. */
function collectCookieHeaderFromResponse(res: Response): string {
	const headers = res.headers as Headers & { getSetCookie?: () => string[] }
	if (typeof headers.getSetCookie !== "function") {
		return ""
	}
	const pairs = headers
		.getSetCookie()
		.map((line) => line.split(";")[0]?.trim())
		.filter((p): p is string => Boolean(p))
	return pairs.join("; ")
}

/** True when Sogou returned a captcha / block page (only use after organic parse yielded zero results). */
function isSogouLikelyBlockedPage(html: string): boolean {
	const t = html.slice(0, 120_000).toLowerCase()
	if (/<title>[^<]*(?:安全验证|访问异常|人机验证)[^<]*<\/title>/i.test(html)) {
		return true
	}
	if (t.includes("secuniq") && (t.includes("验证码") || t.includes("verify"))) {
		return true
	}
	if (t.includes("/antispider/") || t.includes("antispider/index")) {
		return true
	}
	return false
}

function normalizeMaybeProtocolRelativeUrl(href: string): string {
	const h = href.trim()
	if (h.startsWith("//")) {
		return `https:${h}`
	}
	return h
}

/** Baidu SERP title links: /link?, baidu.php?, optional // or http(s). */
function isBaiduSerpJumpHref(href: string): boolean {
	const n = normalizeMaybeProtocolRelativeUrl(href)
	return /^https?:\/\/(?:www\.)?baidu\.com\/(?:link\?|baidu\.php\?)/i.test(n)
}

function stripHtmlTags(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
}

function extractSnippetFromBlock(block: string, patterns: RegExp[]): string {
	for (const pattern of patterns) {
		const m = block.match(pattern)
		if (m) {
			const text = stripHtmlTags(m[1]!).trim()
			if (text.length >= 15) {
				return text.substring(0, 300)
			}
		}
	}
	return ""
}

function extractBaiduSnippet(html: string, afterPos: number): string {
	const block = html.substring(afterPos, afterPos + 5000)
	return extractSnippetFromBlock(block, BAIDU_SNIPPET_PATTERNS)
}

const BAIDU_SNIPPET_PATTERNS: RegExp[] = [
	/class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i,
	/class="[^"]*cos-text-body[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i,
	/class="[^"]*(?:content-right|c-span-last)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i,
	/class="[^"]*(?:content|abstract|desc|paragraph|summary)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i,
	/<span[^>]+class="[^"]*"[^>]*>([\s\S]{30,600}?)<\/span>/i,
	/<p[^>]*>([\s\S]{20,500}?)<\/p>/i,
]

const SOGOU_SNIPPET_PATTERNS: RegExp[] = [
	/class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i,
	/class="[^"]*(?:str_info|star-wiki)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i,
	/class="[^"]*txt-info[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i,
	/class="[^"]*(?:rb|text|desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i,
	/<p[^>]*>([\s\S]{20,500}?)<\/p>/i,
]

export class TavilySearchProvider implements WebSearchProvider {
	constructor(private apiKey: string) {}

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const truncatedQuery = query.length > 400 ? query.slice(0, 400) : query
		const { controller, clear } = makeAbortController()

		try {
			const response = await safeFetch("https://api.tavily.com/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					api_key: this.apiKey,
					query: truncatedQuery,
					max_results: Math.min(count, 10),
					search_depth: "advanced",
					include_answer: true,
					include_raw_content: false,
				}),
				signal: controller.signal,
			})

			if (!response.ok) {
				if (response.status === 429) {
					throw new Error("Tavily rate limited. Please wait a moment and try again.")
				}
				throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`)
			}

			const data = (await response.json()) as {
				answer?: string
				results?: Array<{ title?: string; url?: string; content?: string }>
			}

			if (!data.results || !Array.isArray(data.results)) {
				return []
			}

			const results: WebSearchResult[] = data.results.map((r) => ({
				title: r.title || "Untitled",
				url: r.url || "",
				snippet: r.content || "",
			}))

			if (data.answer) {
				results.unshift({ title: "AI-Generated Summary", url: "", snippet: data.answer })
			}

			return results
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("Tavily search timed out after 15 seconds.")
			}
			throw error
		} finally {
			clear()
		}
	}
}

export class BingSearchProvider implements WebSearchProvider {
	constructor(private apiKey: string) {}

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController()

		try {
			const params = new URLSearchParams({
				q: query,
				count: String(Math.min(count, 10)),
				mkt: "zh-CN",
				responseFilter: "Webpages",
			})

			const response = await safeFetch(`https://api.bing.microsoft.com/v7.0/search?${params}`, {
				headers: { "Ocp-Apim-Subscription-Key": this.apiKey },
				signal: controller.signal,
			})

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error("Bing API key is invalid. Please check your key in Azure Portal.")
				}
				if (response.status === 429) {
					throw new Error("Bing rate limited. Please wait and try again.")
				}
				throw new Error(`Bing search failed: ${response.status} ${response.statusText}`)
			}

			const data = (await response.json()) as {
				webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string }> }
			}

			return (data.webPages?.value ?? []).map((r) => ({
				title: r.name || "Untitled",
				url: r.url || "",
				snippet: r.snippet || "",
			}))
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("Bing search timed out after 15 seconds.")
			}
			throw error
		} finally {
			clear()
		}
	}
}

export class GoogleSearchProvider implements WebSearchProvider {
	private apiKey: string
	private cx: string

	constructor(apiKey: string) {
		const parts = apiKey.split("|")
		this.apiKey = parts[0] ?? ""
		this.cx = parts[1] ?? ""
	}

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		if (!this.cx) {
			throw new Error(
				"Google search requires API Key and Search Engine ID separated by '|'. " +
					"Format: YOUR_API_KEY|YOUR_CX_ID",
			)
		}

		const { controller, clear } = makeAbortController()

		try {
			const params = new URLSearchParams({
				key: this.apiKey,
				cx: this.cx,
				q: query,
				num: String(Math.min(count, 10)),
			})

			const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
				signal: controller.signal,
			})

			if (!response.ok) {
				if (response.status === 403) {
					throw new Error("Google API key is invalid or quota exceeded.")
				}
				throw new Error(`Google search failed: ${response.status} ${response.statusText}`)
			}

			const data = (await response.json()) as {
				items?: Array<{ title?: string; link?: string; snippet?: string }>
			}

			return (data.items ?? []).map((r) => ({
				title: r.title || "Untitled",
				url: r.link || "",
				snippet: r.snippet || "",
			}))
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("Google search timed out after 15 seconds.")
			}
			throw error
		} finally {
			clear()
		}
	}
}

export class BaiduSearchProvider implements WebSearchProvider {
	constructor(private apiKey: string) {}

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController()

		try {
			const params = new URLSearchParams({
				query: query,
				page_num: "1",
				page_size: String(Math.min(count, 10)),
			})

			const response = await fetch(`https://aip.baidubce.com/rest/2.0/search/v1/resource/web?${params}`, {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				signal: controller.signal,
			})

			if (!response.ok) {
				if (response.status === 401) {
					throw new Error("Baidu API token is invalid or expired.")
				}
				throw new Error(`Baidu search failed: ${response.status} ${response.statusText}`)
			}

			const data = (await response.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>
			}

			return (data.results ?? []).map((r) => ({
				title: (r.title || "Untitled").replace(/<[^>]*>/g, ""),
				url: r.url || "",
				snippet: (r.content || "").replace(/<[^>]*>/g, ""),
			}))
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("Baidu search timed out after 15 seconds.")
			}
			throw error
		} finally {
			clear()
		}
	}
}

export class BaiduFreeSearchProvider implements WebSearchProvider {
	private sogouFallback?: SogouFreeSearchProvider

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		let baiduError: string | undefined

		try {
			const results = await this.fetchBaidu(query, count)
			if (results.length > 0) {
				return results
			}
			baiduError = "Baidu returned no parseable results (anti-bot or layout change)."
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				baiduError = "Baidu search timed out."
			} else {
				baiduError = formatFetchFailureMessage(error)
			}
		}

		try {
			this.sogouFallback ??= new SogouFreeSearchProvider()
			const results = await this.sogouFallback.search(query, count)
			if (results.length > 0) {
				return results
			}
			throw new Error("Sogou fallback returned no results")
		} catch (fallbackErr) {
			const fb = formatFetchFailureMessage(fallbackErr)
			throw new Error(
				`Baidu search failed: ${baiduError}. ` +
					`Sogou fallback also failed: ${fb}. ` +
					"Check network/proxy, or set web search provider to Tavily/Bing/Google in settings.",
			)
		}
	}

	private async fetchBaidu(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController(15_000)
		try {
			const params = new URLSearchParams({ wd: query, rn: String(Math.min(count, 10)), ie: "utf-8" })
			const response = await fetch(`https://www.baidu.com/s?${params}`, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
					Referer: "https://www.baidu.com/",
					Connection: "keep-alive",
				},
				redirect: "follow",
				signal: controller.signal,
			})

			if (!response.ok) {
				throw new Error(`Baidu returned ${response.status}`)
			}

			const html = (await response.text()).slice(0, 500_000)
			return this.parseBaiduResults(html, count)
		} finally {
			clear()
		}
	}

	private parseBaiduResults(html: string, maxResults: number): WebSearchResult[] {
		const results: WebSearchResult[] = []
		const seenUrl = new Set<string>()

		const pushResult = (rawHref: string, titleHtml: string, snippetAfterIndex: number) => {
			if (!isBaiduSerpJumpHref(rawHref)) return
			const url = normalizeMaybeProtocolRelativeUrl(rawHref)
			const title = stripHtmlTags(titleHtml).trim()
			if (!title || title.length < 2) return
			if (seenUrl.has(url)) return
			seenUrl.add(url)
			const snippet = extractBaiduSnippet(html, snippetAfterIndex)
			results.push({ title, url, snippet })
		}

		// Any <h3>…<a href="…">…</a>…</h3> where href is a Baidu jump URL (link? / baidu.php?, // or http(s))
		const h3Regex = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi
		let match: RegExpExecArray | null
		while ((match = h3Regex.exec(html)) !== null && results.length < maxResults) {
			pushResult(match[1]!, match[2]!, match.index + match[0].length)
		}

		if (results.length < maxResults) {
			const containerRegex =
				/class="[^"]*c-container[^"]*"[^>]*(?:data-click[^>]*)?>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=class="[^"]*c-container|$)/gi
			while ((match = containerRegex.exec(html)) !== null && results.length < maxResults) {
				const linkMatch = match[1]!.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
				if (!linkMatch) continue
				const rawHref = linkMatch[1]!
				if (!isBaiduSerpJumpHref(rawHref)) continue
				const url = normalizeMaybeProtocolRelativeUrl(rawHref)
				const title = stripHtmlTags(linkMatch[2]!).trim()
				if (!title || title.length < 2) continue
				if (seenUrl.has(url)) continue
				seenUrl.add(url)
				const snippet = extractSnippetFromBlock(match[2]!, BAIDU_SNIPPET_PATTERNS)
				results.push({ title, url, snippet })
			}
		}

		return results
	}
}

export class SogouFreeSearchProvider implements WebSearchProvider {
	private static readonly UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController(22_000)

		try {
			let cookieHeader = ""
			try {
				const warm = await fetch("https://www.sogou.com/", {
					headers: {
						"User-Agent": SogouFreeSearchProvider.UA,
						Accept: "text/html,application/xhtml+xml",
						"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
						"Upgrade-Insecure-Requests": "1",
					},
					redirect: "follow",
					signal: controller.signal,
				})
				cookieHeader = collectCookieHeaderFromResponse(warm)
			} catch {
				// Warm-up is best-effort; continue without cookies
			}

			const params = new URLSearchParams({ query, ie: "utf8" })
			const response = await fetch(`https://www.sogou.com/web?${params}`, {
				headers: {
					"User-Agent": SogouFreeSearchProvider.UA,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
					Referer: "https://www.sogou.com/",
					...(cookieHeader ? { Cookie: cookieHeader } : {}),
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-User": "?1",
					"Upgrade-Insecure-Requests": "1",
				},
				redirect: "follow",
				signal: controller.signal,
			})

			if (!response.ok) {
				throw new Error(`Sogou returned ${response.status}`)
			}

			const html = (await response.text()).slice(0, 500_000)
			const results = this.parseSogouResults(html, count)
			if (results.length > 0) {
				return results
			}

			if (isSogouLikelyBlockedPage(html)) {
				throw new Error(
					"Sogou returned a verification / anti-bot page (no organic results). Try again later or use Tavily/Baidu API in settings.",
				)
			}

			return []
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("Sogou search timed out.")
			}
			throw new Error(`Sogou search failed: ${getErrorMessage(error)}`)
		} finally {
			clear()
		}
	}

	private parseSogouResults(html: string, maxResults: number): WebSearchResult[] {
		const results: WebSearchResult[] = []
		const seen = new Set<string>()
		const h3Regex = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi
		let match: RegExpExecArray | null

		while ((match = h3Regex.exec(html)) !== null && results.length < maxResults) {
			let url = match[1]!
			const title = stripHtmlTags(match[2]!).trim()
			if (!title || title.length < 2) continue

			if (url.startsWith("/link?")) {
				url = `https://www.sogou.com${url}`
			}

			// Skip in-page nav / vertical tabs (still h3+a but not web results)
			if (url.includes("sogou.com/sogou?") && title.includes("相关")) {
				continue
			}

			if (seen.has(url)) continue
			seen.add(url)

			const afterBlock = html.substring(match.index + match[0].length, match.index + match[0].length + 3000)
			const snippet = extractSnippetFromBlock(afterBlock, SOGOU_SNIPPET_PATTERNS)
			results.push({ title, url, snippet })
		}
		return results
	}
}

export class DuckDuckGoSearchProvider implements WebSearchProvider {
	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController(15_000)

		try {
			const response = await fetch("https://lite.duckduckgo.com/lite/", {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
					Accept: "text/html",
				},
				body: new URLSearchParams({ q: query }).toString(),
				signal: controller.signal,
			})

			if (!response.ok) {
				throw new Error(`DuckDuckGo returned ${response.status}`)
			}

			const html = (await response.text()).slice(0, 500_000)
			const results: WebSearchResult[] = []
			const linkRegex = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
			const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi
			const links: { url: string; title: string }[] = []
			const snippets: string[] = []

			let m: RegExpExecArray | null
			while ((m = linkRegex.exec(html)) !== null && links.length < 100) {
				links.push({ url: m[1]!, title: m[2]!.replace(/<[^>]*>/g, "").trim() })
			}
			while ((m = snippetRegex.exec(html)) !== null && snippets.length < 100) {
				snippets.push(m[1]!.replace(/<[^>]*>/g, "").trim())
			}

			for (let i = 0; i < Math.min(links.length, count); i++) {
				const link = links[i]
				if (link?.url && link.title) {
					results.push({ title: link.title, url: link.url, snippet: snippets[i] ?? "" })
				}
			}
			return results
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("DuckDuckGo search timed out.")
			}
			throw new Error(`DuckDuckGo search failed: ${getErrorMessage(error)}`)
		} finally {
			clear()
		}
	}
}

export type SerpApiEngine = "bing" | "google" | "baidu" | "yandex" | "yahoo" | "duckduckgo"

export class SerpApiSearchProvider implements WebSearchProvider {
	private static readonly MAX_RETRIES = 3
	private static readonly BASE_DELAY_MS = 2000

	constructor(
		private apiKey: string,
		private engine: SerpApiEngine = "bing",
	) {}

	async search(query: string, count: number): Promise<WebSearchResult[]> {
		const { controller, clear } = makeAbortController()

		try {
			const params = new URLSearchParams({
				api_key: this.apiKey,
				q: query,
				num: String(Math.min(count, 10)),
				engine: this.engine,
			})

			let lastError: Error | undefined
			for (let attempt = 0; attempt <= SerpApiSearchProvider.MAX_RETRIES; attempt++) {
				if (attempt > 0) {
					const delay = SerpApiSearchProvider.BASE_DELAY_MS * Math.pow(2, attempt - 1)
					await new Promise((resolve) => setTimeout(resolve, delay))
				}

				const response = await fetch(`https://serpapi.com/search.json?${params}`, {
					signal: controller.signal,
				})

				if (response.status === 429) {
					lastError = new Error(
						`SerpAPI rate limited (attempt ${attempt + 1}/${SerpApiSearchProvider.MAX_RETRIES + 1}). ` +
							(attempt < SerpApiSearchProvider.MAX_RETRIES
								? "Retrying..."
								: "Free plan: 100 searches/month. Upgrade at https://serpapi.com/pricing"),
					)
					continue
				}

				if (!response.ok) {
					if (response.status === 401) {
						throw new Error("SerpAPI key is invalid. Check your key at https://serpapi.com/manage-api-key")
					}
					throw new Error(`SerpAPI search failed: ${response.status} ${response.statusText}`)
				}

				const data = (await response.json()) as {
					answer_box?: { snippet?: string; title?: string; link?: string }
					organic_results?: Array<{ title?: string; link?: string; snippet?: string }>
				}

				const results: WebSearchResult[] = (data.organic_results ?? []).map((r) => ({
					title: r.title || "Untitled",
					url: r.link || "",
					snippet: r.snippet || "",
				}))

				if (data.answer_box?.snippet) {
					results.unshift({
						title: data.answer_box.title || "Answer",
						url: data.answer_box.link || "",
						snippet: data.answer_box.snippet,
					})
				}

				return results
			}

			throw lastError ?? new Error("SerpAPI search failed after retries.")
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error("SerpAPI search timed out after 15 seconds.")
			}
			throw error
		} finally {
			clear()
		}
	}
}

export function createSearchProvider(
	providerName: WebSearchProviderName,
	apiKey: string,
	serpApiEngine?: SerpApiEngine,
): WebSearchProvider {
	switch (providerName) {
		case "bing":
			return new BingSearchProvider(apiKey)
		case "google":
			return new GoogleSearchProvider(apiKey)
		case "baidu":
			return new BaiduSearchProvider(apiKey)
		case "serpapi":
			return new SerpApiSearchProvider(apiKey, serpApiEngine ?? "bing")
		case "duckduckgo":
			return new DuckDuckGoSearchProvider()
		case "baidu-free":
			return new BaiduFreeSearchProvider()
		case "sogou-free":
			return new SogouFreeSearchProvider()
		case "tavily":
		default:
			return new TavilySearchProvider(apiKey)
	}
}

export function getSearchProviderInfo(): Record<
	WebSearchProviderName,
	{ label: string; keyHint: string; noKey?: boolean }
> {
	return {
		"baidu-free": {
			label: t("search_provider.baidu_free_label"),
			keyHint: t("search_provider.baidu_free_hint"),
			noKey: true,
		},
		"sogou-free": {
			label: t("search_provider.sogou_free_label"),
			keyHint: t("search_provider.sogou_free_hint"),
			noKey: true,
		},
		duckduckgo: { label: "DuckDuckGo (Free)", keyHint: "No key; may not work in China", noKey: true },
		tavily: { label: "Tavily", keyHint: "https://tavily.com" },
		bing: { label: "Bing", keyHint: "Azure Portal → Bing Search API" },
		google: { label: "Google", keyHint: "API_KEY|CX_ID (Google Custom Search)" },
		baidu: { label: "Baidu API", keyHint: "Baidu AI Cloud Access Token" },
		serpapi: { label: "SerpAPI", keyHint: "https://serpapi.com" },
	}
}

export function formatSearchResults(results: WebSearchResult[]): string {
	if (results.length === 0) {
		return "No relevant web search results found."
	}

	const parts: string[] = []

	for (const r of results) {
		if (r.title === "AI-Generated Summary") {
			parts.push(`## Summary\n${r.snippet}`)
		} else {
			parts.push(`### ${r.title}${r.url ? `\nSource: ${r.url}` : ""}\n${r.snippet}`)
		}
	}

	return parts.join("\n\n---\n\n")
}
