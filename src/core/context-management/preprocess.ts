import { ApiMessage } from "../task-persistence/apiMessages"
import { contextCollapseMessages } from "./contextCollapse"
import { logger } from "../../shared/logger"

export type PreprocessResult = {
	messages: ApiMessage[]
	collapsed: boolean
}

export type PreprocessOptions = {
	contextPercent: number
	enableMicroCompact: boolean
	/** Timestamps of the assistant messages (ISO strings) for time-based trigger evaluation */
	assistantTimestamps?: string[]
}

// ── Time-based microcompact ──

/**
 * Default gap threshold in minutes. When `now - lastAssistantMessage.timestamp`
 * exceeds this threshold, the server-side prompt cache has almost certainly
 * expired (provider cache TTL is typically 1 hour). At that point we content-clear
 * old tool results to shrink the rewritten prompt.
 *
 * Override with env var CLAUDE_CODE_TIME_BASED_MC_GAP_MINUTES.
 */
const TIME_BASED_GAP_THRESHOLD_MINUTES =
	(typeof process !== "undefined" && process.env?.CLAUDE_CODE_TIME_BASED_MC_GAP_MINUTES
		? parseInt(process.env.CLAUDE_CODE_TIME_BASED_MC_GAP_MINUTES, 10) || 60
		: 60)
/** Keep this many most-recent compactable tool results when TBM fires */
const TIME_BASED_KEEP_RECENT = 5
/** Marker string for content-cleared tool results */
const TIME_BASED_CLEARED_MESSAGE = "[Old tool result content cleared]"

const COMPACTABLE_TOOLS = new Set<string>([
	"read_file",
	"search_files",
	"grep_search",
	"execute_command",
	"web_search",
	"web_fetch",
	"write_to_file",
	"apply_diff",
	"insert_content",
	"search_and_replace",
])

/**
 * Check if the time-based trigger should fire.
 * Returns the compactable tool_use IDs found in the messages when trigger fires,
 * or null when it doesn't (disabled, no timestamps, gap under threshold).
 */
function evaluateTimeBasedTrigger(
	messages: ApiMessage[],
	timestamps?: string[],
): { compactableIds: string[]; keepSet: Set<string> } | null {
	if (!timestamps || timestamps.length === 0) return null

	const lastTimestamp = timestamps[timestamps.length - 1]
	if (!lastTimestamp) return null

	const gapMinutes = (Date.now() - new Date(lastTimestamp).getTime()) / 60_000
	if (!Number.isFinite(gapMinutes) || gapMinutes < TIME_BASED_GAP_THRESHOLD_MINUTES) return null

	// Collect compactable tool_use IDs from assistant messages
	const compactableIds: string[] = []
	for (const msg of messages) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use" && COMPACTABLE_TOOLS.has(block.name)) {
					compactableIds.push(block.id)
				}
			}
		}
	}

	if (compactableIds.length === 0) return null

	// Keep the most recent N, clear the rest
	const keepRecent = Math.max(1, TIME_BASED_KEEP_RECENT)
	const keepSet = new Set(compactableIds.slice(-keepRecent))

	return { compactableIds, keepSet }
}

/**
 * Apply time-based microcompact: replace old tool results with a placeholder
 * when the server cache has definitely expired (idle > 60 min).
 * Returns the mutated messages and a boolean indicating whether any tool
 * results were cleared.
 */
function applyTimeBasedMicrocompact(
	messages: ApiMessage[],
	timestamps?: string[],
): { messages: ApiMessage[]; cleared: boolean } {
	const trigger = evaluateTimeBasedTrigger(messages, timestamps)
	if (!trigger) return { messages, cleared: false }

	const { keepSet } = trigger
	let tokensSaved = 0
	let cleared = false

	const result = messages.map((msg) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

		let touched = false
		const newContent = msg.content.map((block: any) => {
			if (
				block.type === "tool_result" &&
				!keepSet.has(block.tool_use_id) &&
				block.content !== TIME_BASED_CLEARED_MESSAGE
			) {
				tokensSaved += typeof block.content === "string" ? block.content.length : 0
				touched = true
				return { ...block, content: TIME_BASED_CLEARED_MESSAGE }
			}
			return block
		})

		if (!touched) return msg
		cleared = true
		return { ...msg, content: newContent }
	})

	if (tokensSaved > 0) {
		logger.info("ContextManagement",
			`[TIME-BASED MC] gap > ${TIME_BASED_GAP_THRESHOLD_MINUTES}min, ` +
			`cleared ~${Math.round(tokensSaved / 4)} tokens from old tool results, ` +
			`kept last ${keepSet.size}`,
		)
	}

	return { messages: result, cleared }
}

// ── Tool result budget helpers (inlined to enable single-pass merge) ──

const DEFAULT_MAX_CHARS_BY_TOOL: Record<string, number> = {
	read_file: 30_000,
	search_files: 15_000,
	grep_search: 15_000,
	execute_command: 20_000,
	web_search: 10_000,
	web_fetch: 10_000,
}
const DEFAULT_MAX_CHARS = 20_000
const RECENT_KEEP_FULL = 4

function truncateHeadTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const head = Math.max(200, Math.floor(maxChars * 0.6))
	const tail = Math.max(120, maxChars - head)
	return `${text.slice(0, head)}\n\n...[tool result compacted, ${text.length - head - tail} chars omitted]...\n\n${text.slice(-tail)}`
}

function compactByTool(text: string, toolName: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const normalizedTool = toolName.toLowerCase()
	if (normalizedTool === "grep_search" || normalizedTool === "search_files") {
		const lines = text.split("\n")
		const kept = lines.slice(0, 120)
		const omitted = Math.max(0, lines.length - kept.length)
		const summarized = `${kept.join("\n")}\n\n[search results compacted: omitted ${omitted} lines due to context budget]`
		if (summarized.length <= maxChars) return summarized
	}
	if (normalizedTool === "read_file") {
		const head = Math.max(300, Math.floor(maxChars * 0.7))
		const tail = Math.max(150, maxChars - head)
		return `${text.slice(0, head)}\n\n...[file content compacted for context window]...\n\n${text.slice(-tail)}`
	}
	return truncateHeadTail(text, maxChars)
}

function resolveBudget(toolName: string, agePenaltyLevel: number): number {
	const base = DEFAULT_MAX_CHARS_BY_TOOL[toolName.toLowerCase()] ?? DEFAULT_MAX_CHARS
	const ratio = agePenaltyLevel >= 3 ? 0.4 : agePenaltyLevel === 2 ? 0.55 : agePenaltyLevel === 1 ? 0.75 : 1
	return Math.max(1200, Math.floor(base * ratio))
}

function buildToolUseIdMap(messages: ApiMessage[]): Map<string, string> {
	const map = new Map<string, string>()
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue
		for (const block of m.content) {
			if (block.type === "tool_use" && block.id && block.name) {
				map.set(block.id, block.name)
			}
		}
	}
	return map
}

// ── Snip helpers (inlined) ──

const SNIP_MAX_CHARS = 600
const SNIP_TRIGGER_PERCENT =
	typeof process !== "undefined" && process.env?.CLAUDE_CODE_SNIP_TRIGGER_PERCENT
		? parseInt(process.env.CLAUDE_CODE_SNIP_TRIGGER_PERCENT, 10) || 50
		: 50
const SNIP_KEEP_RECENT =
	typeof process !== "undefined" && process.env?.CLAUDE_CODE_SNIP_KEEP_RECENT
		? parseInt(process.env.CLAUDE_CODE_SNIP_KEEP_RECENT, 10) || 10
		: 10

/**
 * Returns the number of Unicode code points in a string.
 * String.length counts UTF-16 code units, which breaks for surrogate pairs
 * (emoji, rare CJK). [...s].length gives the correct code-point count.
 */
function codePointLength(s: string): number {
	return [...s].length
}

function sliceCodePoints(s: string, start: number, end?: number): string {
	return [...s].slice(start, end).join("")
}

function compactLongText(text: string): string {
	if (codePointLength(text) <= SNIP_MAX_CHARS) return text
	const head = Math.floor(SNIP_MAX_CHARS * 0.7)
	const tail = SNIP_MAX_CHARS - head
	const headPart = sliceCodePoints(text, 0, head)
	const tailPart = sliceCodePoints(text, -tail)
	const omitted = codePointLength(text) - SNIP_MAX_CHARS
	return `${headPart}\n...[snip compacted ~${omitted} chars]...\n${tailPart}`
}

// ── Combined single-pass preprocessor ──

/**
 * Single-pass message preprocessing that merges tool-result budget and text-snip
 * compaction into one array allocation, then optionally applies context collapse.
 *
 * The original three-layer chain (microcompact → snipCompact → collapse) could
 * allocate up to three intermediate arrays. This version allocates at most one
 * (the combined pass result), plus the collapse result when triggered at very
 * high context percentages.
 */
export function preprocessMessages(
	messages: ApiMessage[],
	options: PreprocessOptions,
): PreprocessResult {
	if (messages.length === 0) {
		return { messages, collapsed: false }
	}

	// --- Time-based microcompact (runs first) ---
	// When the gap since last assistant message exceeds 60 min, the server cache
	// is guaranteed expired. Replace old tool results with a placeholder to shrink
	// the rewritten prompt. Mutates messages in-place for the subsequent passes.
	let msgs = messages
	const tbmc = applyTimeBasedMicrocompact(msgs, options.assistantTimestamps)
	if (tbmc.cleared) {
		msgs = tbmc.messages
	}

	const collapseTriggerPercent =
		typeof process !== "undefined" && process.env?.CLAUDE_CODE_COLLAPSE_TRIGGER_PERCENT
			? parseInt(process.env.CLAUDE_CODE_COLLAPSE_TRIGGER_PERCENT, 10) || 70
			: 70
	const collapseKeepRecent =
		typeof process !== "undefined" && process.env?.CLAUDE_CODE_COLLAPSE_KEEP_RECENT
			? parseInt(process.env.CLAUDE_CODE_COLLAPSE_KEEP_RECENT, 10) || 14
			: 14

	const contextPercent = options.contextPercent
	const snipBoundary = Math.max(0, msgs.length - SNIP_KEEP_RECENT)
	const snipEnabled = contextPercent >= SNIP_TRIGGER_PERCENT

	// Fast path: neither compaction layer is active
	if (!options.enableMicroCompact && !snipEnabled) {
		return contextCollapseMessages(msgs, { contextPercent, triggerPercent: collapseTriggerPercent, keepRecentMessages: collapseKeepRecent })
	}

	// Build toolUseId → name map once (one scan)
	const toolUseIdToName = options.enableMicroCompact ? buildToolUseIdMap(msgs) : null

	// Single pass: apply both tool result budget + snip compaction
	const budgetBoundary = Math.max(0, msgs.length - RECENT_KEEP_FULL)
	let changed = false
	const out = msgs.map((m, idx) => {
		let msg = m

		// Layer 1: tool result budget (for old messages with tool_result blocks)
		if (options.enableMicroCompact && idx < budgetBoundary && Array.isArray(msg.content)) {
			const age = budgetBoundary - idx
			const agePenalty = age >= 18 ? 3 : age >= 10 ? 2 : age >= 5 ? 1 : 0
			let blockChanged = false
			const nextBlocks = msg.content.map((block: any) => {
				if (block.type !== "tool_result") return block
				const toolUseId = block.tool_use_id
				const toolName = (toolUseId && toolUseIdToName?.get(toolUseId)) ?? "unknown_tool"
				const budget = resolveBudget(toolName, agePenalty)
				if (typeof block.content === "string") {
					const compacted = compactByTool(block.content, toolName, budget)
					if (compacted !== block.content) {
						blockChanged = true
						return { ...block, content: compacted }
					}
					return block
				}
				const encoded = JSON.stringify(block.content)
				if (encoded.length <= budget) return block
				blockChanged = true
				return { ...block, content: compactByTool(encoded, toolName, budget) }
			})
			if (blockChanged) {
				changed = true
				msg = { ...msg, content: nextBlocks }
			}
		}

		// Layer 2: snip long text content (for old messages with string content)
		if (snipEnabled && idx < snipBoundary && typeof msg.content === "string") {
			const compacted = compactLongText(msg.content)
			if (compacted !== msg.content) {
				changed = true
				msg = { ...msg, content: compacted }
			}
		}

		return msg
	})

	const combined = changed ? out : msgs

	// Structural collapse (rare — only triggered at very high context)
	return contextCollapseMessages(combined, { contextPercent, triggerPercent: collapseTriggerPercent, keepRecentMessages: collapseKeepRecent })
}
