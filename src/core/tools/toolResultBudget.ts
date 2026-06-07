/**
 * Tool Result Budget Management
 *
 * Provides token budget calculation and truncation for tool results to prevent
 * single tool results from consuming excessive context window space.
 * Inspired by Claude Code's `applyToolResultBudget` design.
 */

import { Tiktoken } from "tiktoken/lite"
import o200kBase from "tiktoken/encoders/o200k_base"
import type { Anthropic } from "@anthropic-ai/sdk"
import type { ApiMessage } from "../task-persistence/apiMessages"

// ─── Budget Constants ────────────────────────────────────────────────────────

/** Single result maximum ratio of context window */
const SINGLE_RESULT_MAX_RATIO = 0.15

/** Absolute upper limit for a single result (tokens) */
const SINGLE_RESULT_MAX_TOKENS = 30_000

/** All tool results total budget ratio of context window */
const TOTAL_TOOL_RESULT_RATIO = 0.4

/** History result decay period: budget halves every N turns */
const HISTORY_DECAY_TURNS = 3

/** Minimum budget floor to avoid over-aggressive truncation */
const MIN_BUDGET_TOKENS = 500

/** Fraction of preserved content allocated to head */
const HEAD_RATIO = 0.3

/** Fraction of preserved content allocated to tail */
const TAIL_RATIO = 0.2

// ─── Encoder (module-level, init is fast) ──────────────────────────────────────

const _encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)

/**
 * Estimate token count for a string.
 * Uses tiktoken for accuracy with a small fudge factor.
 */
export function estimateTokens(text: string): number {
	if (!text || text.length === 0) return 0
	return _encoder.encode(text, undefined, []).length
}

// ─── Core Functions ──────────────────────────────────────────────────────────

export interface ToolResultBudget {
	/** Max tokens for a single tool result */
	singleMax: number
	/** Max tokens for all tool results combined */
	totalMax: number
}

/**
 * Calculate tool result token budgets based on context window size.
 */
export function getToolResultBudget(contextWindow: number): ToolResultBudget {
	const singleMax = Math.min(Math.floor(contextWindow * SINGLE_RESULT_MAX_RATIO), SINGLE_RESULT_MAX_TOKENS)
	const totalMax = Math.floor(contextWindow * TOTAL_TOOL_RESULT_RATIO)
	return {
		singleMax: Math.max(singleMax, MIN_BUDGET_TOKENS),
		totalMax: Math.max(totalMax, MIN_BUDGET_TOKENS),
	}
}

/**
 * Truncate a single tool result string to fit within a token budget.
 *
 * Strategy:
 *  - If within budget, return as-is
 *  - Otherwise keep head (30%) and tail (20%), replace middle with summary
 *  - For code results, attempt to preserve complete function/class boundaries
 *
 * @param result   - The tool result text
 * @param budgetTokens - Maximum allowed tokens
 * @returns The (possibly truncated) result string
 */
export function truncateToolResult(result: string, budgetTokens: number): string {
	if (!result || result.length === 0) return result

	const currentTokens = estimateTokens(result)
	if (currentTokens <= budgetTokens) return result

	// Calculate how many tokens we can keep
	const keepTokens = Math.max(budgetTokens - 30, MIN_BUDGET_TOKENS) // 30 tokens reserved for the summary line

	// Convert token budget to approximate character positions
	// Average ~4 chars per token for English/code content
	const avgCharsPerToken = Math.max(result.length / currentTokens, 1)
	const headChars = Math.floor(keepTokens * HEAD_RATIO * avgCharsPerToken)
	const tailChars = Math.floor(keepTokens * TAIL_RATIO * avgCharsPerToken)

	if (headChars + tailChars >= result.length) return result

	let headEnd = headChars
	let tailStart = result.length - tailChars

	// For code content, try to snap to line boundaries
	const headNewline = result.indexOf("\n", headEnd)
	if (headNewline !== -1 && headNewline < headEnd + 200) {
		headEnd = headNewline + 1
	}
	const tailNewline = result.lastIndexOf("\n", tailStart)
	if (tailNewline !== -1 && tailNewline > tailStart - 200) {
		tailStart = tailNewline + 1
	}

	// Make sure we don't overlap
	if (headEnd >= tailStart) return result

	const headPart = result.slice(0, headEnd)
	const tailPart = result.slice(tailStart)

	const keptTokens = estimateTokens(headPart) + estimateTokens(tailPart)
	// Agent-facing truncation summary — intentionally kept in Chinese for LLM context
	const summaryLine = `\n[... 内容已裁剪，原始 ${currentTokens} tokens，保留 ${keptTokens} tokens ...]\n`

	return headPart + summaryLine + tailPart
}

/**
 * Check if a content block contains image data (should not be truncated).
 */
function isImageContent(content: UnsafeAny): boolean {
	if (Array.isArray(content)) {
		return content.some((block) => (block as UnsafeAny as Record<string, UnsafeAny>).type === "image")
	}
	return false
}

/**
 * Extract the text content from a tool_result block.
 * Returns null if the content is non-text (e.g. image).
 */
function getToolResultText(block: Anthropic.Messages.ToolResultBlockParam): string | null {
	if (typeof block.content === "string") {
		return block.content
	}
	if (Array.isArray(block.content)) {
		// If it contains images, don't truncate
		if (block.content.some((item: UnsafeAny) => item.type === "image")) {
			return null
		}
		const textParts = block.content
			.filter((item: UnsafeAny) => item.type === "text")
			.map((item: UnsafeAny) => item.text || "")
		return textParts.join("\n")
	}
	return null
}

/**
 * Set the text content of a tool_result block, preserving its format.
 */
function setToolResultText(
	block: Anthropic.Messages.ToolResultBlockParam,
	newText: string,
): Anthropic.Messages.ToolResultBlockParam {
	if (typeof block.content === "string") {
		return { ...block, content: newText }
	}
	if (Array.isArray(block.content)) {
		// Replace text blocks, keep non-text blocks
		const nonTextBlocks = block.content.filter((item: UnsafeAny) => item.type !== "text")
		return {
			...block,
			content: [{ type: "text" as const, text: newText }, ...nonTextBlocks],
		}
	}
	return { ...block, content: newText }
}

/**
 * Apply progressive compression to tool results in message history.
 *
 * Older tool results get smaller budgets (decay by half every HISTORY_DECAY_TURNS turns).
 * Only compresses history messages, not the current turn.
 *
 * @param messages       - Full API conversation history
 * @param contextWindow  - Model context window size in tokens
 * @param currentTurn    - The current turn number (0-based, counted by user messages)
 * @returns A new messages array with compressed tool results (does NOT mutate the original)
 */
export function applyToolResultBudget(
	messages: ApiMessage[],
	contextWindow: number,
	currentTurn: number,
): ApiMessage[] {
	const budget = getToolResultBudget(contextWindow)

	// Count user messages to determine turn numbers
	let turnIndex = 0
	const result: ApiMessage[] = []

	for (const message of messages) {
		if (message.role === "user") {
			turnIndex++
		}

		// Only compress tool results in history (not the current turn)
		if (message.role === "user" && turnIndex < currentTurn && Array.isArray(message.content)) {
			const turnsAgo = currentTurn - turnIndex
			// Decay: budget halves every HISTORY_DECAY_TURNS
			const decayFactor = Math.pow(0.5, Math.floor(turnsAgo / HISTORY_DECAY_TURNS))
			const turnBudget = Math.max(Math.floor(budget.singleMax * decayFactor), MIN_BUDGET_TOKENS)

			let modified = false
			const newContent = message.content.map((block) => {
				if ((block as UnsafeAny as Record<string, UnsafeAny>).type !== "tool_result") return block

				const toolResultBlock = block as Anthropic.Messages.ToolResultBlockParam

				// Skip image results
				if (isImageContent(toolResultBlock.content)) return block

				const text = getToolResultText(toolResultBlock)
				if (text === null) return block

				// Skip short results
				const tokens = estimateTokens(text)
				if (tokens <= turnBudget) return block

				// Truncate
				const truncated = truncateToolResult(text, turnBudget)
				if (truncated !== text) {
					modified = true
					return setToolResultText(toolResultBlock, truncated)
				}
				return block
			})

			if (modified) {
				result.push({ ...message, content: newContent })
			} else {
				result.push(message)
			}
		} else {
			result.push(message)
		}
	}

	return result
}
