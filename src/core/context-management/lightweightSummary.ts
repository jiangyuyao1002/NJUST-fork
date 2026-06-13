import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@njust-ai/core/providers"
import { loadSessionMemories, formatSessionMemoriesForPrompt } from "../condense/sessionMemoryCompact"
import { hasToolResults } from "./grouping"
import { TOKEN_BUFFER_TOKENS } from "./truncation"

export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */

export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	if (!autoCondenseContext) {
		// When auto-condense is disabled, only truncation can occur
		const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
		const prevContextTokens = totalTokens + lastMessageTokens
		const allowedTokens = Math.max(0, contextWindow - reservedTokens - TOKEN_BUFFER_TOKENS)
		return prevContextTokens > allowedTokens
	}

	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = Math.max(0, contextWindow - reservedTokens - TOKEN_BUFFER_TOKENS)

	// Determine the effective threshold to use
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		}
		// Invalid values fall back to global setting (effectiveThreshold already set)
	}

	const contextPercent = contextWindow > 0 ? Math.round((100 * prevContextTokens) / contextWindow) : 0
	// Start condense slightly before the exact profile threshold to reduce “one more turn then hit limit” surprises.
	const nearCondenseThreshold =
		autoCondenseContext &&
		contextWindow > 0 &&
		contextPercent >= effectiveThreshold - 1.5 &&
		contextPercent < effectiveThreshold

	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens || Boolean(nearCondenseThreshold)
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export function tryBuildLightweightSummary(
	messages: ApiMessage[],
	taskId: string,
	allowedTokens: number,
): { messages: ApiMessage[]; summary: string } | null {
	// Need at least a few messages to summarize
	if (messages.length < 4) return null

	// Extract structured information from messages
	const userMessages: string[] = []
	const fileOps: string[] = []
	const toolNames = new Set<string>()
	let lastAssistantText = ""

	for (const msg of messages) {
		if (msg.isSummary || msg.isTruncationMarker) continue
		if (msg.condenseParent || msg.truncationParent) continue

		const content = typeof msg.content === "string" ? msg.content : ""
		if (msg.role === "user" && content.length > 0 && !hasToolResults(msg)) {
			// Truncate very long user messages for the summary
			const truncated = content.length > 1000 ? content.slice(0, 1000) + "..." : content
			userMessages.push(truncated)
		}
		if (msg.role === "assistant") {
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						toolNames.add(block.name)
						if (
							["write_to_file", "apply_diff", "insert_content", "search_and_replace"].includes(block.name)
						) {
							const input = (block as Anthropic.Messages.ToolUseBlockParam).input as
								| Record<string, unknown>
								| undefined
							if (typeof input?.filePath === "string") fileOps.push(input.filePath)
							else if (typeof input?.path === "string") fileOps.push(input.path)
						}
					}
					if (block.type === "text") {
						lastAssistantText = (block as Anthropic.Messages.TextBlockParam).text || ""
					}
				}
			}
		}
	}

	if (userMessages.length === 0 && fileOps.length === 0) return null

	// Build structured summary
	const sections: string[] = ["## Conversation Summary (auto-extracted)"]

	if (userMessages.length > 0) {
		sections.push(`### User Messages\n${userMessages.map((m, i) => `${i + 1}. ${m}`).join("\n")}`)
	}

	if (fileOps.length > 0) {
		const uniqueFiles = [...new Set(fileOps)].slice(0, 10)
		sections.push(`### Files Modified\n${uniqueFiles.map((f) => `- ${f}`).join("\n")}`)
	}

	if (toolNames.size > 0) {
		sections.push(`### Tools Used\n${[...toolNames].slice(0, 10).join(", ")}`)
	}

	if (lastAssistantText.length > 0) {
		const truncated = lastAssistantText.length > 2000 ? lastAssistantText.slice(0, 2000) + "..." : lastAssistantText
		sections.push(`### Last Assistant Context\n${truncated}`)
	}

	const summaryText = sections.join("\n\n")

	// Rough token estimate: if the summary + remaining messages would exceed
	// the allowed token budget, return null to fall through to LLM condensation
	// (which produces a denser summary)
	const estimatedSummaryTokens = summaryText.length / 4
	if (estimatedSummaryTokens > allowedTokens * 0.3) {
		// Summary alone would consume >30% of allowed budget — too verbose,
		// let LLM condensation produce a more concise version
		return null
	}

	// Build summary message and tag old messages
	const condenseId = crypto.randomUUID()
	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryText,
		ts: Date.now(),
		isSummary: true,
		condenseId,
		compactMetadata: {
			trigger: "auto",
			source: "lightweight",
			preCompactTokenCount: messages.length,
			messagesSummarized: messages.filter((m) => !m.isSummary && !m.condenseParent).length,
			timestamp: Date.now(),
		},
	}

	const newMessages = messages.map((msg) => {
		if (!msg.condenseParent && !msg.isSummary) {
			return { ...msg, condenseParent: condenseId }
		}
		return msg
	})
	newMessages.push(summaryMessage)

	return { messages: newMessages, summary: summaryText }
}

/**
 * Try to use persisted cross-session memories as a zero-cost compact summary.
 *
 * Loads session memories saved by persistSessionMemory() from previous sessions
 * and formats them as a structured summary, avoiding an expensive LLM API call.
 *
 * Returns null if no session memories are available or the budget is exceeded.
 */

export async function trySessionMemoryCompaction(
	messages: ApiMessage[],
	workspaceDir: string | undefined,
	allowedTokens: number,
): Promise<{ messages: ApiMessage[]; summary: string } | null> {
	if (!workspaceDir) return null

	// Need at least a few messages to compact
	if (messages.length < 4) return null

	const memories = await loadSessionMemories(workspaceDir)
	if (memories.length === 0) return null

	// Budget: use up to 30% of allowed tokens (same ratio as tryBuildLightweightSummary)
	const budget = Math.floor(allowedTokens * 0.3)
	const summaryText = formatSessionMemoriesForPrompt(memories, budget)
	if (!summaryText) return null

	// Rough token estimate -- skip if too verbose
	const estimatedSummaryTokens = summaryText.length / 4
	if (estimatedSummaryTokens > allowedTokens * 0.3) return null

	const condenseId = crypto.randomUUID()
	const summaryMessage: ApiMessage = {
		role: "user",
		content: summaryText,
		ts: Date.now(),
		isSummary: true,
		condenseId,
		compactMetadata: {
			trigger: "auto",
			source: "session_memory",
			preCompactTokenCount: messages.length,
			messagesSummarized: messages.filter((m) => !m.isSummary && !m.condenseParent).length,
			timestamp: Date.now(),
		},
	}

	const newMessages = messages.map((msg) => {
		if (!msg.condenseParent && !msg.isSummary) {
			return { ...msg, condenseParent: condenseId }
		}
		return msg
	})
	newMessages.push(summaryMessage)

	return { messages: newMessages, summary: summaryText }
}
