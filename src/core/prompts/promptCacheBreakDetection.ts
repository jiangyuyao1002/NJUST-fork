/**
 * Prompt Cache Break Detection
 *
 * Monitors system prompt stability across API calls to detect
 * unnecessary cache invalidations. Logs changes and their sources
 * to help maximize prompt cache hit rates.
 */

import crypto from "crypto"

export interface CacheBreakEvent {
	timestamp: number
	previousHash: string
	currentHash: string
	changeSource: CacheBreakSource
	staticPartChanged: boolean
	dynamicPartChanged: boolean
	changedTools?: string[]
	previousToolHashes?: Record<string, string>
	currentToolHashes?: Record<string, string>
}

export type CacheBreakSource =
	| "mcp_tools_changed"
	| "custom_instructions_changed"
	| "mode_switched"
	| "skills_changed"
	| "environment_info_changed"
	| "tools_list_changed"
	| "unknown"

/**
 * Normalize prompt content before hashing to avoid spurious cache breaks.
 *
 * - Strips ISO-8601 timestamps and common date/time patterns that change
 *   every request (e.g. "2026-04-12T08:30:00Z", "Saturday, April 12, 2026").
 * - Sorts MCP tool definitions that appear as JSON-like blocks so that
 *   ordering changes do not invalidate the cache.
 * - Collapses consecutive whitespace to a single space.
 */
export function normalizePromptContent(content: string): string {
	let normalized = content

	// Remove ISO-8601 timestamps (e.g. 2026-04-12T08:30:00.000Z)
	normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<TIMESTAMP>")

	// Remove common English date strings like "Saturday, April 12, 2026" or "April 12, 2026"
	normalized = normalized.replace(
		/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/gi,
		"<DATE>",
	)

	// Remove CJK date formats (e.g. "2026年4月27日", "4月27日 14:30")
	normalized = normalized.replace(/\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gi, "<DATE>")
	normalized = normalized.replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/gi, "<DATE>")

	// Remove numeric date formats (e.g. "2026-04-27", "04/27/2026", "27/04/2026")
	normalized = normalized.replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/g, "<DATE>")

	// Remove time strings like "12:30 PM", "08:30:00"
	normalized = normalized.replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/gi, "<TIME>")
	// Remove CJK time format (e.g. "14:30", "14时30分")
	normalized = normalized.replace(/\d{1,2}\s*时\s*\d{1,2}\s*分/gi, "<TIME>")

	// Sort lines that look like MCP tool entries (heuristic: lines starting with "- " inside a tools block)
	// This handles the common case where MCP tool lists are rendered as markdown lists.
	normalized = sortToolListBlocks(normalized)

	// Collapse consecutive whitespace (but preserve newlines structure)
	normalized = normalized.replace(/[ \t]+/g, " ")

	return normalized
}

/**
 * Sort markdown-style tool list blocks to ensure stable ordering.
 * Looks for contiguous blocks of lines starting with "- " and sorts them.
 */
function sortToolListBlocks(content: string): string {
	const lines = content.split("\n")
	const result: string[] = []
	let listBuffer: string[] = []

	for (const line of lines) {
		if (line.trimStart().startsWith("- ")) {
			listBuffer.push(line)
		} else {
			if (listBuffer.length > 1) {
				listBuffer.sort()
			}
			result.push(...listBuffer)
			listBuffer = []
			result.push(line)
		}
	}

	// Flush remaining buffer
	if (listBuffer.length > 1) {
		listBuffer.sort()
	}
	result.push(...listBuffer)

	return result.join("\n")
}

export class PromptCacheBreakDetector {
	private lastStaticHash: string | null = null
	private lastDynamicHash: string | null = null
	private lastFullHash: string | null = null
	private lastToolHashes: Record<string, string> = {}
	private breakEvents: CacheBreakEvent[] = []
	private readonly maxEvents: number = 100

	/**
	 * Check if the system prompt has changed since the last call.
	 * Call this before each API request with the current system prompt.
	 *
	 * @param staticPart - The static portion of the system prompt (before DYNAMIC_BOUNDARY)
	 * @param dynamicPart - The dynamic portion (after DYNAMIC_BOUNDARY)
	 * @returns null if no change, or a CacheBreakEvent if cache will be invalidated
	 */
	check(staticPart: string, dynamicPart: string, toolPayloads?: Record<string, string>): CacheBreakEvent | null {
		const normalizedStatic = normalizePromptContent(staticPart)
		const normalizedDynamic = normalizePromptContent(dynamicPart)

		const staticHash = this.computeHash(normalizedStatic)
		const dynamicHash = this.computeHash(normalizedDynamic)
		const fullHash = this.computeHash(normalizedStatic + normalizedDynamic)
		const currentToolHashes = this.computeToolHashes(toolPayloads)

		// First call — just record
		if (this.lastFullHash === null) {
			this.lastStaticHash = staticHash
			this.lastDynamicHash = dynamicHash
			this.lastFullHash = fullHash
			this.lastToolHashes = currentToolHashes
			return null
		}

		// No change
		if (fullHash === this.lastFullHash) {
			return null
		}

		// Detect what changed
		const staticChanged = staticHash !== this.lastStaticHash
		const dynamicChanged = dynamicHash !== this.lastDynamicHash

		const changedTools = this.diffChangedTools(this.lastToolHashes, currentToolHashes)
		const event: CacheBreakEvent = {
			timestamp: Date.now(),
			previousHash: this.lastFullHash,
			currentHash: fullHash,
			changeSource: this.inferChangeSource(staticChanged, dynamicChanged, changedTools),
			staticPartChanged: staticChanged,
			dynamicPartChanged: dynamicChanged,
			changedTools,
			previousToolHashes: this.lastToolHashes,
			currentToolHashes,
		}

		// Record event
		this.breakEvents.push(event)
		if (this.breakEvents.length > this.maxEvents) {
			this.breakEvents.shift()
		}

		// Update hashes
		this.lastStaticHash = staticHash
		this.lastDynamicHash = dynamicHash
		this.lastFullHash = fullHash
		this.lastToolHashes = currentToolHashes

		return event
	}

	/**
	 * Get recent cache break events for diagnostics
	 */
	getRecentEvents(count: number = 10): CacheBreakEvent[] {
		return this.breakEvents.slice(-count)
	}

	/**
	 * Get the total number of cache breaks detected
	 */
	getTotalBreaks(): number {
		return this.breakEvents.length
	}

	/**
	 * Get breakdown of breaks by source
	 */
	getBreaksBySource(): Record<CacheBreakSource, number> {
		const sources: CacheBreakSource[] = [
			"mcp_tools_changed",
			"custom_instructions_changed",
			"mode_switched",
			"skills_changed",
			"environment_info_changed",
			"tools_list_changed",
			"unknown",
		]
		const result = {} as Record<CacheBreakSource, number>
		for (const s of sources) {
			result[s] = 0
		}
		for (const event of this.breakEvents) {
			result[event.changeSource]++
		}
		return result
	}

	reset(): void {
		this.lastStaticHash = null
		this.lastDynamicHash = null
		this.lastFullHash = null
		this.lastToolHashes = {}
		this.breakEvents = []
	}

	private computeHash(content: string): string {
		return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
	}

	private computeToolHashes(toolPayloads?: Record<string, string>): Record<string, string> {
		if (!toolPayloads) return {}
		const entries = Object.entries(toolPayloads).sort(([a], [b]) => a.localeCompare(b))
		const out: Record<string, string> = {}
		for (const [toolName, payload] of entries) {
			out[toolName] = this.computeHash(normalizePromptContent(payload))
		}
		return out
	}

	private diffChangedTools(prev: Record<string, string>, curr: Record<string, string>): string[] {
		const keys = new Set([...Object.keys(prev), ...Object.keys(curr)])
		return [...keys].filter((k) => prev[k] !== curr[k]).sort()
	}

	private inferChangeSource(
		staticChanged: boolean,
		dynamicChanged: boolean,
		changedTools: string[],
	): CacheBreakSource {
		if (changedTools.length > 0) return "mcp_tools_changed"
		// Static part changes are rare and significant — likely tool definitions changed
		if (staticChanged && !dynamicChanged) return "tools_list_changed"
		// Dynamic-only changes are usually environment info, custom instructions, etc.
		if (!staticChanged && dynamicChanged) return "environment_info_changed"
		// Both changed — hard to tell, mark unknown
		return "unknown"
	}
}

// Global singleton
export const globalPromptCacheBreakDetector = new PromptCacheBreakDetector()
