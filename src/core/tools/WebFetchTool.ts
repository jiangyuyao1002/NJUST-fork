import axios from "axios"
import * as cheerio from "cheerio"
import dns from "node:dns/promises"
import net from "node:net"
import TurndownService from "turndown"
import { z } from "zod"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { assertSafeOutboundUrl } from "../security/networkGuard"
import { assertPublicIp } from "../security/networkGuard"

const MAX_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_LENGTH = 100_000

function isIPAddress(hostname: string): boolean {
	return net.isIP(hostname) !== 0
}

class WebFetchToolImpl extends BaseTool<"web_fetch"> {
	readonly name = "web_fetch" as const

	override isReadOnly(): boolean {
		return true
	}

	override isConcurrencySafe(): boolean {
		return true
	}

	override getEagerExecutionDecision() {
		return "eager" as const
	}
	override isPartialArgsStable(
		partial: Partial<{ url: string; format?: "text" | "html" | "json" | "markdown"; maxLength?: number }>,
	): boolean {
		if (typeof partial.url !== "string" || partial.url.length === 0) return false
		try {
			const parsed = new URL(partial.url)
			return parsed.protocol === "http:" || parsed.protocol === "https:"
		} catch {
			return false
		}
	}

	override userFacingName(): string {
		return "Web Fetch"
	}

	override get searchHint(): string {
		return "web fetch http url page content"
	}

	protected override get inputSchema() {
		return z.object({
			url: z.string().url("url must be a valid URL"),
			format: z.enum(["text", "html", "json", "markdown"]).optional(),
			maxLength: z.number().int().positive().optional(),
		})
	}

	async execute(
		params: { url: string; format?: "text" | "html" | "json" | "markdown"; maxLength?: number },
		_task: Task,
		{ askApproval, handleError, pushToolResult, reportProgress }: ToolCallbacks,
	): Promise<void> {
		try {
			const { url, format = "text", maxLength = DEFAULT_MAX_LENGTH } = params

			let parsedUrl: URL
			let hostname: string
			let pinnedIp: string | undefined
			try {
				parsedUrl = await assertSafeOutboundUrl(url)
				hostname = parsedUrl.hostname
			} catch (error) {
				pushToolResult(formatResponse.toolError(error instanceof Error ? error.message : `Invalid URL: ${url}`))
				return
			}

			// IP pinning: resolve hostname once, then connect directly to the
			// verified IP with a Host header. This eliminates the DNS rebinding
			// window that exists with pre/post comparison.
			if (!isIPAddress(hostname)) {
				const resolved = await dns.lookup(hostname, { all: true, verbatim: true })
				if (!resolved.length) {
					pushToolResult(formatResponse.toolError(`Could not resolve host: ${hostname}`))
					return
				}
				for (const entry of resolved) {
					assertPublicIp(entry.address)
				}
				pinnedIp = resolved[0]!.address
			}

			const approved = await askApproval("tool", JSON.stringify({ tool: "web_fetch", url, format }))
			if (!approved) {
				pushToolResult("Web fetch was not approved by the user.")
				return
			}

			await reportProgress?.({ icon: "globe", text: `Fetching ${url}` })

			// Manual redirect loop with SSRF guard + IP pinning at each step
			const MAX_REDIRECTS = 5
			let currentUrl = url
			let currentHostname = hostname
			let currentPinnedIp = pinnedIp
			let redirectCount = 0
			let response

			while (true) {
				// If IP pinning is active, replace the hostname in the URL
				// with the pinned IP and set the Host header.
				const requestUrl = currentUrl
				const requestHeaders: Record<string, string> = {
					"User-Agent": "Mozilla/5.0 (compatible; NjustAi/1.0; +https://github.com/JunjieChen0/Njust-AI)",
					Accept: format === "json" ? "application/json" : "text/html,application/xhtml+xml,*/*",
				}
				if (currentPinnedIp) {
					const ipUrl = new URL(currentUrl)
					ipUrl.hostname = net.isIP(currentPinnedIp) === 6 ? `[${currentPinnedIp}]` : currentPinnedIp
					currentUrl = ipUrl.toString()
					requestHeaders["Host"] = currentHostname
				}

				response = await axios.get(currentUrl, {
					timeout: MAX_TIMEOUT_MS,
					maxRedirects: 0,
					maxContentLength: MAX_BODY_BYTES,
					maxBodyLength: MAX_BODY_BYTES,
					responseType: format === "json" ? "json" : "text",
					headers: requestHeaders,
					validateStatus: (status) => status < 400,
				})

				// Check for 3xx redirect
				if (response.status >= 300 && response.status < 400 && redirectCount < MAX_REDIRECTS) {
					const location = response.headers?.location as string | undefined
					if (!location) break

					// Resolve relative URL using the original URL, then SSRF-guard
					const redirectUrl = new URL(location, requestUrl).href
					await assertSafeOutboundUrl(redirectUrl)

					const redirectParsed = new URL(redirectUrl)
					// If redirecting to a different host, resolve it
					if (redirectParsed.hostname !== currentHostname) {
						currentHostname = redirectParsed.hostname
						currentPinnedIp = undefined
						if (!isIPAddress(redirectParsed.hostname)) {
							const redirectIps = await dns.lookup(redirectParsed.hostname, { all: true, verbatim: true })
							if (redirectIps.length) {
								for (const entry of redirectIps) assertPublicIp(entry.address)
								currentPinnedIp = redirectIps[0]!.address
							}
						}
					}
					// Same host — reuse the pinned IP

					currentUrl = redirectUrl
					redirectCount++
					continue
				}
				break
			}

			let result: string

			switch (format) {
				case "json": {
					const data =
						typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2)
					result = data
					break
				}
				case "html": {
					result = typeof response.data === "string" ? response.data : String(response.data)
					break
				}
				case "markdown": {
					const htmlContent = typeof response.data === "string" ? response.data : String(response.data)
					const $ = cheerio.load(htmlContent)
					// Remove script/style tags
					$("script, style, noscript, iframe").remove()
					const bodyHtml = $("body").html() || $("html").html() || htmlContent
					const turndown = new TurndownService({
						headingStyle: "atx",
						codeBlockStyle: "fenced",
					})
					result = turndown.turndown(bodyHtml)
					break
				}
				case "text":
				default: {
					const htmlContent = typeof response.data === "string" ? response.data : String(response.data)
					const $ = cheerio.load(htmlContent)
					$("script, style, noscript, iframe").remove()
					result = $("body").text() || $("html").text() || htmlContent
					// Collapse whitespace
					result = result.replace(/\s+/g, " ").trim()
					break
				}
			}

			// Truncate if exceeding maxLength
			if (result.length > maxLength) {
				result = result.slice(0, maxLength) + `\n\n[Truncated: content exceeded ${maxLength} characters]`
			}

			pushToolResult(result)
		} catch (error) {
			if (axios.isAxiosError(error)) {
				const status = error.response?.status
				const statusText = error.response?.statusText || error.message
				pushToolResult(
					formatResponse.toolError(
						`HTTP request failed${status ? ` (${status} ${statusText})` : ""}: ${error.message}`,
					),
				)
			} else {
				await handleError("web fetch", error instanceof Error ? error : new Error(String(error)))
			}
		} finally {
			this.resetPartialState()
		}
	}
}

export const webFetchTool = new WebFetchToolImpl()
