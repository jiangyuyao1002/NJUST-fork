import { ApiMessage } from "../task-persistence/apiMessages"
import { ContextHierarchy, findTurnIndex, computeTurnSelfAttentionMean } from "./contextHierarchy"

// ── Single-result and round-level budget constants ──────────────────
export const DEFAULT_MAX_SINGLE_RESULT_CHARS = 100_000 // 单个工具结果上限 100KB
export const DEFAULT_MAX_ROUND_TOTAL_CHARS = 300_000 // 单轮所有工具结果总上限 300KB

/**
 * Truncate a tool result string to a maximum number of characters.
 * Appends a notice when truncation occurs.
 */
export function truncateToolResult(result: string, maxChars: number, toolName?: string): string {
	if (result.length <= maxChars) return result

	const truncated = result.slice(0, maxChars)
	const totalLength = result.length
	return `${truncated}\n\n[Truncated: showing first ${maxChars.toLocaleString()} of ${totalLength.toLocaleString()} total characters${toolName ? ` from ${toolName}` : ""}]`
}

/**
 * Manages per-round budget for tool results.
 * Applies both a per-result cap and a cumulative round cap.
 */
export class ToolResultBudgetManager {
	private currentRoundUsed: number = 0
	private readonly maxSingleResult: number
	private readonly maxRoundTotal: number

	constructor(config?: { maxSingleResult?: number; maxRoundTotal?: number }) {
		this.maxSingleResult = config?.maxSingleResult ?? DEFAULT_MAX_SINGLE_RESULT_CHARS
		this.maxRoundTotal = config?.maxRoundTotal ?? DEFAULT_MAX_ROUND_TOTAL_CHARS
	}

	/**
	 * Apply budget to a tool result. Returns the (possibly truncated) result.
	 */
	applyBudget(result: string, toolName?: string): string {
		// 1. Apply single-result limit
		let processed = truncateToolResult(result, this.maxSingleResult, toolName)

		// 2. Check round total budget
		const remaining = this.maxRoundTotal - this.currentRoundUsed
		if (processed.length > remaining && remaining > 0) {
			processed = truncateToolResult(processed, remaining, toolName)
		}

		this.currentRoundUsed += processed.length
		return processed
	}

	/** Reset for a new round of tool execution */
	resetRound(): void {
		this.currentRoundUsed = 0
	}

	/** Get current round usage */
	getRoundUsage(): { used: number; limit: number; percent: number } {
		return {
			used: this.currentRoundUsed,
			limit: this.maxRoundTotal,
			percent: this.currentRoundUsed / this.maxRoundTotal,
		}
	}
}

export type ToolResultBudgetOptions = {
	maxCharsByTool?: Record<string, number>
	defaultMaxChars?: number
	recentMessagesToKeepFull?: number
}

const DEFAULT_MAX_CHARS_BY_TOOL: Record<string, number> = {
	read_file: 30_000,
	search_files: 15_000,
	grep_search: 15_000,
	execute_command: 20_000,
	web_search: 10_000,
	web_fetch: 10_000,
}

const DEFAULT_MAX_CHARS = 20_000
const DEFAULT_RECENT_MESSAGES_TO_KEEP_FULL = 4

function truncateWithHeadTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	const head = Math.max(200, Math.floor(maxChars * 0.6))
	const tail = Math.max(120, maxChars - head)
	return `${text.slice(0, head)}\n\n...[tool result compacted, ${text.length - head - tail} chars omitted]...\n\n${text.slice(-tail)}`
}

function compactByToolHeuristic(text: string, toolName: string, maxChars: number): string {
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

	return truncateWithHeadTail(text, maxChars)
}

function resolveBudgetByTool(
	block: { name?: string },
	maxCharsByTool: Record<string, number>,
	defaultMaxChars: number,
	agePenaltyLevel: number,
	turnImportance?: number,
): number {
	const tool = (block.name ?? "").toLowerCase()
	const base = maxCharsByTool[tool] ?? defaultMaxChars
	const ratio = agePenaltyLevel >= 3 ? 0.4 : agePenaltyLevel === 2 ? 0.55 : agePenaltyLevel === 1 ? 0.75 : 1
	// HCA: scale by turn importance — high-importance turns retain more content
	const importanceRatio = turnImportance !== undefined ? 0.5 + turnImportance * 0.5 : 1.0
	return Math.max(1200, Math.floor(base * ratio * importanceRatio))
}

/**
 * Build a mapping from tool_use_id to tool name by scanning all assistant messages.
 */
function buildToolUseIdToNameMap(messages: ApiMessage[]): Map<string, string> {
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

/**
 * Apply conservative budget compaction to historical tool results.
 * Keeps recent messages intact and progressively tightens budget for older messages.
 */
export function applyToolResultBudget(
	messages: ApiMessage[],
	opts?: ToolResultBudgetOptions,
	hierarchy?: ContextHierarchy,
): ApiMessage[] {
	if (messages.length === 0) return messages

	const maxCharsByTool = { ...DEFAULT_MAX_CHARS_BY_TOOL, ...(opts?.maxCharsByTool ?? {}) }
	const defaultMaxChars = opts?.defaultMaxChars ?? DEFAULT_MAX_CHARS
	const keepRecent = opts?.recentMessagesToKeepFull ?? DEFAULT_RECENT_MESSAGES_TO_KEEP_FULL
	const boundary = Math.max(0, messages.length - keepRecent)
	const toolUseIdToName = buildToolUseIdToNameMap(messages)

	let changed = false
	const out: ApiMessage[] = messages.map((m, index) => {
		if (index >= boundary || !Array.isArray(m.content)) return m

		const age = boundary - index
		const agePenaltyLevel = age >= 18 ? 3 : age >= 10 ? 2 : age >= 5 ? 1 : 0
		// HCA: compute turn importance for budget scaling
		let turnImportance: number | undefined
		if (hierarchy) {
			const turnIdx = findTurnIndex(hierarchy, index)
			if (turnIdx >= 0) {
				turnImportance = computeTurnSelfAttentionMean(hierarchy, turnIdx)
			}
		}
		const blocks = m.content
		let blockChanged = false
		const nextBlocks = blocks.map((block) => {
			if (block.type !== "tool_result") return block
			const toolUseId = (block as { tool_use_id?: string }).tool_use_id
			const toolName = (toolUseId && toolUseIdToName.get(toolUseId)) ?? "unknown_tool"
			const budget = resolveBudgetByTool(
				{ name: toolName },
				maxCharsByTool,
				defaultMaxChars,
				agePenaltyLevel,
				turnImportance,
			)
			if (typeof block.content === "string") {
				const compacted = compactByToolHeuristic(block.content, toolName, budget)
				if (compacted !== block.content) {
					blockChanged = true
					return { ...block, content: compacted }
				}
				return block
			}
			const encoded = JSON.stringify(block.content)
			if (encoded.length <= budget) return block
			const compacted = compactByToolHeuristic(encoded, toolName, budget)
			blockChanged = true
			return { ...block, content: compacted }
		})
		if (!blockChanged) return m
		changed = true
		return { ...m, content: nextBlocks }
	})

	return changed ? out : messages
}
