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

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Partial<{url: string; format?: "text" | "html" | "json" | "markdown"; maxLength?: number}>): boolean {
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
			try {
				parsedUrl = await assertSafeOutboundUrl(url)
				hostname = parsedUrl.hostname
			} catch (error) {
				pushToolResult(
					formatResponse.toolError(error instanceof Error ? error.message : `Invalid URL: ${url}`),
				)
				return
			}

			// Capture pre-request DNS resolution for rebinding detection
			let preRequestIPs: Set<string> | undefined
			if (!isIPAddress(hostname)) {
				const preLookup = await dns.lookup(hostname, { all: true, verbatim: true })
				if (!preLookup.length) {
					pushToolResult(formatResponse.toolError(`Could not resolve host: ${hostname}`))
					return
				}
				for (const entry of preLookup) {
					assertPublicIp(entry.address)
				}
				preRequestIPs = new Set(preLookup.map((e) => e.address))
			}

			const approved = await askApproval(
				"tool",
				JSON.stringify({ tool: "web_fetch", url, format }),
			)
			if (!approved) {
				pushToolResult("Web fetch was not approved by the user.")
				return
			}

			await reportProgress?.({ icon: "globe", text: `Fetching ${url}` })

			const response = await axios.get(url, {
				timeout: MAX_TIMEOUT_MS,
				maxRedirects: 5,
				maxContentLength: MAX_BODY_BYTES,
				maxBodyLength: MAX_BODY_BYTES,
				// Validate each redirect target through the same SSRF guard as the initial URL
				beforeRedirect: async (_options, responseHeaders) => {
					const location = (responseHeaders as Record<string, UnsafeAny>)?.location
					if (location && typeof location === "string") {
						await assertSafeOutboundUrl(location)
					}
				},
				responseType: format === "json" ? "json" : "text",
				headers: {
					"User-Agent": "Mozilla/5.0 (compatible; NjustAi/1.0; +https://github.com/JunjieChen0/Njust-AI)",
					Accept: format === "json" ? "application/json" : "text/html,application/xhtml+xml,*/*",
				},
				validateStatus: (status) => status < 400,
			})

			// DNS rebinding check: compare pre-request and post-request IPs
			if (preRequestIPs && preRequestIPs.size > 0) {
				const postLookup = await dns.lookup(hostname, { all: true, verbatim: true })
				if (!postLookup.length) {
					throw new Error(`DNS resolution lost after request for host: ${hostname}`)
				}
				for (const entry of postLookup) {
					assertPublicIp(entry.address)
				}
				const postIPs = new Set(postLookup.map((e) => e.address))
				const changed =
					preRequestIPs.size !== postIPs.size ||
					[...preRequestIPs].some((ip) => !postIPs.has(ip))
				if (changed) {
					throw new Error(
						`Potential DNS rebinding detected for host: ${hostname} — request blocked.`,
					)
				}
			}

			let result: string

			switch (format) {
				case "json": {
					const data = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2)
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
