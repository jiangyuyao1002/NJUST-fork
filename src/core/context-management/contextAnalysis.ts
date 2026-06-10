import { ApiMessage } from "../task-persistence/apiMessages"
import { Anthropic } from "@anthropic-ai/sdk"

/**
 * Token usage breakdown by category.
 */
export type TokenBreakdown = {
	systemPromptTokens: number
	toolResultTokens: number
	toolUseTokens: number
	assistantTextTokens: number
	userMessageTokens: number
	summaryTokens: number
	otherTokens: number
	totalTokens: number
}

/**
 * Detected duplicate file reads in conversation history.
 */
export type DuplicateReadInfo = {
	filePath: string
	readCount: number
	totalSizeChars: number
}

/**
 * Large tool result entry exceeding the threshold.
 */
export type LargeToolResultInfo = {
	turnIndex: number
	toolName: string
	estimatedTokens: number
}

export type ContextAnalysisResult = {
	breakdown: TokenBreakdown
	duplicateReads: DuplicateReadInfo[]
	estimatedDuplicateReadTokens: number
	largeToolResults: LargeToolResultInfo[]
	summaryMessageCount: number
	totalMessageCount: number
}

/**
 * Rough estimate of characters per token for non-LLM token counting.
 */
const CHARS_PER_TOKEN = 4

/** Tool results exceeding this many estimated tokens are flagged as large. */
export const LARGE_RESULT_THRESHOLD = 2000 // tokens

function estimateCharTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Detected known file read tool names from content blocks.
 */
const FILE_READ_TOOL_NAMES = new Set(["read_file"])

/**
 * Analyze messages and produce a token usage breakdown by category.
 *
 * Walks all messages to categorize content into: system prompt area,
 * tool results, tool uses, assistant reasoning, user messages, summaries,
 * and duplicate reads.
 */
export function analyzeContextTokens(messages: ApiMessage[], systemPromptTokens: number = 0): ContextAnalysisResult {
	// First pass: collect tool_use id->name mappings and file-read IDs.
	// The id->name map resolves tool names for LargeToolResultInfo
	// (tool_use_id is an Anthropic UUID, not a human-readable name).
	const toolUseIdToName = new Map<string, string>()
	const fileReadToolUseIds = new Set<string>()
	for (const msg of messages) {
		const content = msg.content
		if (!Array.isArray(content)) continue
		for (const block of content) {
			if (block.type === "tool_use") {
				// block is narrowed to ToolUseBlockParam by the .type check
				if (block.id) toolUseIdToName.set(block.id, block.name || "unknown")
				if (FILE_READ_TOOL_NAMES.has(block.name)) {
					fileReadToolUseIds.add(block.id)
				}
			}
		}
	}

	let toolResultTokens = 0
	let toolUseTokens = 0
	let assistantTextTokens = 0
	let userMessageTokens = 0
	let summaryTokens = 0
	let otherTokens = 0
	const fileReads = new Map<string, { count: number; totalChars: number }>()
	const largeToolResults: LargeToolResultInfo[] = []

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!

		if (msg.isSummary) {
			const text = getMessageText(msg)
			summaryTokens += estimateCharTokens(text)
			continue
		}

		const content = msg.content
		if (typeof content === "string") {
			if (msg.role === "user") {
				userMessageTokens += estimateCharTokens(content)
			} else if (msg.role === "assistant") {
				assistantTextTokens += estimateCharTokens(content)
			} else {
				otherTokens += estimateCharTokens(content)
			}
			continue
		}

		if (Array.isArray(content)) {
			for (const block of content) {
				const blockText = blockToText(block)
				const tokens = estimateCharTokens(blockText)

				switch (block.type) {
					case "tool_result": {
						toolResultTokens += tokens
						if (tokens > LARGE_RESULT_THRESHOLD) {
							largeToolResults.push({
								turnIndex: i,
								toolName: toolUseIdToName.get(block.tool_use_id) || "unknown",
								estimatedTokens: tokens,
							})
						}
						if (fileReadToolUseIds.has(block.tool_use_id)) {
							const filePath = extractFilePath(blockText)
							if (filePath) {
								const prev = fileReads.get(filePath)
								fileReads.set(filePath, {
									count: (prev?.count || 0) + 1,
									totalChars: (prev?.totalChars || 0) + blockText.length,
								})
							}
						}
						break
					}
					case "tool_use":
						toolUseTokens += tokens
						break
					case "text":
						if (msg.role === "assistant") {
							assistantTextTokens += tokens
						} else if (msg.role === "user") {
							userMessageTokens += tokens
						} else {
							otherTokens += tokens
						}
						break
					default:
						otherTokens += tokens
				}
			}
		}
	}

	const duplicateReads: DuplicateReadInfo[] = []
	for (const [filePath, info] of fileReads) {
		if (info.count > 1) {
			duplicateReads.push({
				filePath,
				readCount: info.count,
				totalSizeChars: info.totalChars,
			})
		}
	}

	let estimatedDuplicateReadTokens = 0
	for (const dup of duplicateReads) {
		estimatedDuplicateReadTokens += (dup.readCount - 1) * 200
	}

	const totalTokens =
		systemPromptTokens +
		toolResultTokens +
		toolUseTokens +
		assistantTextTokens +
		userMessageTokens +
		summaryTokens +
		otherTokens

	const summaryMessageCount = messages.filter((m) => m.isSummary).length

	return {
		breakdown: {
			systemPromptTokens,
			toolResultTokens,
			toolUseTokens,
			assistantTextTokens,
			userMessageTokens,
			summaryTokens,
			otherTokens,
			totalTokens,
		},
		duplicateReads,
		estimatedDuplicateReadTokens,
		largeToolResults,
		summaryMessageCount,
		totalMessageCount: messages.length,
	}
}

/**
 * Format analysis result as a human-readable string for logging or display.
 */
export function formatAnalysisResult(analysis: ContextAnalysisResult): string {
	const b = analysis.breakdown
	const lines: string[] = [
		`Token Breakdown (${b.totalTokens} total):`,
		`  System prompt:  ${b.systemPromptTokens} (${percent(b.systemPromptTokens, b.totalTokens)})`,
		`  Tool results:   ${b.toolResultTokens} (${percent(b.toolResultTokens, b.totalTokens)})`,
		`  Tool uses:      ${b.toolUseTokens} (${percent(b.toolUseTokens, b.totalTokens)})`,
		`  Assistant text: ${b.assistantTextTokens} (${percent(b.assistantTextTokens, b.totalTokens)})`,
		`  User messages:  ${b.userMessageTokens} (${percent(b.userMessageTokens, b.totalTokens)})`,
		`  Summaries:      ${b.summaryTokens} (${percent(b.summaryTokens, b.totalTokens)})`,
		`  Other:          ${b.otherTokens} (${percent(b.otherTokens, b.totalTokens)})`,
	]

	if (analysis.duplicateReads.length > 0) {
		lines.push(
			`\nDuplicate reads (${analysis.duplicateReads.length}, ~${analysis.estimatedDuplicateReadTokens} tokens):`,
		)
		for (const dup of analysis.duplicateReads.slice(0, 5)) {
			lines.push(`  ${dup.filePath} — read ${dup.readCount}x`)
		}
	}

	if (analysis.largeToolResults.length > 0) {
		lines.push(`\nLarge tool results (>2K tokens):`)
		for (const l of analysis.largeToolResults.slice(0, 5)) {
			lines.push(`  Turn ${l.turnIndex}: ~${l.estimatedTokens} tokens`)
		}
	}

	return lines.join("\n")
}

function percent(part: number, total: number): string {
	if (total === 0) return "0%"
	return `${Math.round((part / total) * 100)}%`
}

function getMessageText(msg: ApiMessage): string {
	if (typeof msg.content === "string") return msg.content
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((b: Anthropic.Messages.ContentBlockParam) => {
				if (b.type === "text") return b.text
				if (b.type === "tool_use") return `${b.name}: ${JSON.stringify(b.input)}`
				if (b.type === "tool_result") {
					if (typeof b.content === "string") return b.content
					return (b.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n")
				}
				return ""
			})
			.join("\n")
	}
	return ""
}

function blockToText(block: Anthropic.Messages.ContentBlockParam): string {
	switch (block.type) {
		case "text":
			return block.text
		case "tool_result":
			if (typeof block.content === "string") return block.content
			return (block.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n")
		case "tool_use":
			return `${block.name}: ${JSON.stringify(block.input || {})}`
		default:
			return ""
	}
}

function extractFilePath(text: string): string | null {
	const match = text.match(/File:\s*(.+?)(?:\n|$)/)
	return match ? match[1]!.trim() : null
}
