/**
 * Builds isolated context for sub-tasks based on isolation level.
 *
 * In 'shared' mode: sub-task inherits full parent context (current behavior).
 * In 'forked' mode: sub-task gets a minimal context with only:
 *   - Task description
 *   - Relevant file information
 *   - Essential parent context (no full conversation history)
 *
 * This prevents sub-tasks from inheriting bloated parent contexts,
 * inspired by Claude Code's Fork isolation mode.
 */

import type { SubTaskOptions, ForkedContextConfig, CacheSafeParams } from "./SubTaskOptions"
import { DEFAULT_FORKED_CONTEXT_CONFIG } from "./SubTaskOptions"

export interface ForkedContext {
	/** Task description/objective */
	taskDescription: string
	/** Relevant file paths mentioned in the task */
	relevantFiles: string[]
	/** Essential context extracted from parent (key decisions, current state) */
	essentialContext: string
	/** Context budget for the sub-task */
	contextBudget: number
}

/**
 * Extract relevant file paths from a task description.
 */
export function extractRelevantFiles(taskDescription: string): string[] {
	// Match common file path patterns
	const patterns = [
		/(?:^|\s)((?:\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+\.\w+)/gm, // absolute/relative paths with extensions
		/`([^`]+\.\w{1,10})`/g, // backtick-quoted file references
		/(?:src|lib|test|tests)\/[\w\-./]+\.\w+/g, // src/lib paths
	]

	const files = new Set<string>()
	for (const pattern of patterns) {
		let match
		while ((match = pattern.exec(taskDescription)) !== null) {
			const filePath = match[1] || match[0]
			if (filePath && !filePath.includes("*")) {
				// exclude globs
				files.add(filePath.trim())
			}
		}
	}

	return Array.from(files)
}

/**
 * Extract essential context from parent conversation for forked sub-tasks.
 * Limits to key decisions and current state, excluding verbose tool results.
 */
export function extractEssentialContext(
	parentMessages: Array<{ role: string; content: string }>,
	maxChars: number = 3000,
): string {
	// Take last few assistant messages as they contain the most relevant state
	const relevantMessages = parentMessages
		.filter((m) => m.role === "assistant")
		.slice(-3)
		.map((m) => {
			// Truncate long messages
			if (m.content.length > 1000) {
				return m.content.slice(0, 1000) + "..."
			}
			return m.content
		})

	const context = relevantMessages.join("\n---\n")

	if (context.length > maxChars) {
		return context.slice(-maxChars) // Keep the most recent context
	}

	return context
}

/**
 * Build forked context for a sub-task.
 */
export function buildForkedContext(
	taskDescription: string,
	parentMessages: Array<{ role: string; content: string }>,
	options: SubTaskOptions,
): ForkedContext {
	return {
		taskDescription,
		relevantFiles: extractRelevantFiles(taskDescription),
		essentialContext: extractEssentialContext(parentMessages),
		contextBudget: options.contextBudget ?? 64_000,
	}
}

/**
 * Metadata describing a forked context relationship between parent and child tasks.
 */
export interface TaskForkContext {
	parentTaskId: string
	forkedAt: number // timestamp
	forkedMessageCount: number // parent message count at fork time
	isForked: boolean
}

/**
 * Generate a concise summary of parent conversation history for a forked sub-task.
 * This avoids passing the full conversation history to the child, keeping context lean.
 *
 * The summary includes:
 * - Recent assistant decisions/conclusions
 * - File modifications mentioned
 * - Commands executed
 * - Key context limited to summaryMaxTokens (approx chars * 0.25)
 */
export function generateParentContextSummary(
	parentMessages: Array<{ role: string; content: any }>,
	summaryMaxTokens: number = 10_000,
	config: ForkedContextConfig = DEFAULT_FORKED_CONTEXT_CONFIG,
): string {
	const maxChars = summaryMaxTokens * 4 // rough token-to-char ratio
	const parts: string[] = []

	// Extract text content from message content (handles both string and array formats)
	const getTextContent = (content: any): string => {
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			return content
				.filter((block: { type: string; text?: string }) => block.type === "text" && typeof block.text === "string")
				.map((block: { type: string; text?: string }) => block.text!)
				.join("\n")
		}
		return ""
	}

	// Take only the most recent messages
	const recentMessages = parentMessages.slice(-config.maxRecentMessages)

	// Collect file changes and commands from recent messages
	const fileChanges = new Set<string>()
	const commands: string[] = []
	const keyDecisions: string[] = []

	for (const msg of recentMessages) {
		const text = getTextContent(msg.content)
		if (!text) continue

		if (config.includeFileChanges) {
			// Extract file paths from tool use patterns
			const filePatterns = text.match(/(?:write_to_file|apply_diff|read_file).*?(?:path|file)["':>\s]+([^"'<\n]+)/gi)
			if (filePatterns) {
				for (const match of filePatterns) {
					const pathMatch = match.match(/["':>\s]([^"'<\n]+\.[a-zA-Z]{1,10})$/)
					if (pathMatch) fileChanges.add(pathMatch[1].trim())
				}
			}
		}

		if (config.includeCommands) {
			const cmdPatterns = text.match(/(?:execute_command|command)["':>\s]+([^"'<\n]+)/gi)
			if (cmdPatterns) {
				for (const match of cmdPatterns) {
					const cmdMatch = match.match(/["':>\s]([^"'<\n]+)$/)
					if (cmdMatch) commands.push(cmdMatch[1].trim())
				}
			}
		}

		// Collect key assistant decisions (last few assistant messages)
		if (msg.role === "assistant") {
			const truncated = text.length > 800 ? text.slice(0, 800) + "..." : text
			keyDecisions.push(truncated)
		}
	}

	// Build summary sections
	if (fileChanges.size > 0) {
		parts.push(`[Files referenced]\n${Array.from(fileChanges).join("\n")}`)
	}

	if (commands.length > 0) {
		parts.push(`[Commands executed]\n${commands.slice(-5).join("\n")}`)
	}

	if (keyDecisions.length > 0) {
		// Keep only the last 3 decisions
		const recent = keyDecisions.slice(-3)
		parts.push(`[Recent context]\n${recent.join("\n---\n")}`)
	}

	let summary = parts.join("\n\n")

	// Enforce character limit
	if (summary.length > maxChars) {
		summary = summary.slice(-maxChars)
	}

	return summary || "(No parent context available)"
}

/**
 * Cache-aware fork context result: messages that share the parent's prompt
 * cache prefix, with only the final user message differing per child.
 */
export interface CacheAwareForkContext {
	/** Messages to use as the fork's initial conversation */
	messages: Array<{ role: string; content: any }>
	/** Cache-safe params for the forked agent to reuse */
	cacheSafeParams: CacheSafeParams
}

/**
 * Build a cache-aware fork context that maximizes prompt cache reuse.
 *
 * Instead of a plain-text summary (which produces a completely new prompt),
 * this approach preserves the parent's messages as a byte-identical prefix
 * and only appends a single user message with the task description.
 *
 * The provider's prompt cache key includes: system prompt + tools + model +
 * messages (prefix) + thinking config. By keeping all of these identical
 * between parent and fork, the cache hit rate approaches 100%.
 */
export function buildCacheAwareForkContext(
	taskDescription: string,
	cacheSafeParams: CacheSafeParams,
): CacheAwareForkContext {
	const { forkContextMessages } = cacheSafeParams

	// Build the fork's initial message array:
	// 1. Parent's full conversation prefix (byte-identical for cache hit)
	// 2. Single user message with the task description (only new content)
	const messages: Array<{ role: string; content: any }> = []

	if (forkContextMessages && forkContextMessages.length > 0) {
		messages.push(...forkContextMessages)
	}

	messages.push({
		role: "user",
		content: taskDescription,
	})

	return { messages, cacheSafeParams }
}

/**
 * Build a fork placeholder tool_result. Byte-identical across all fork
 * children to maximize cache hits when the parent continues after spawning.
 */
export function buildForkPlaceholderResult(
	toolUseId: string,
	message: string = "Fork started -- processing in background",
): { role: string; content: any } {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: toolUseId,
				content: message,
			},
		],
	}
}

/**
 * Generate a result summary from a completed task for injection into parent context.
 * Extracts key outcomes: files modified, commands run, and final conclusion.
 * Limited to maxResultChars characters.
 */
export function generateTaskResultSummary(
	taskId: string,
	messages: Array<{ role: string; content: any }>,
	maxResultChars: number = 2000,
): string {
	const parts: string[] = [`[Subtask ${taskId} completed]`]

	// Extract text content helper
	const getTextContent = (content: any): string => {
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			return content
				.filter((block: { type: string; text?: string }) => block.type === "text" && typeof block.text === "string")
				.map((block: { type: string; text?: string }) => block.text!)
				.join("\n")
		}
		return ""
	}

	// Collect files modified
	const filesModified = new Set<string>()
	const commandsExecuted: string[] = []
	let finalConclusion = ""

	for (const msg of messages) {
		const text = getTextContent(msg.content)
		if (!text) continue

		// Extract file modifications
		const writePatterns = text.match(/(?:write_to_file|apply_diff).*?(?:path|file)["':>\s]+([^"'<\n]+)/gi)
		if (writePatterns) {
			for (const match of writePatterns) {
				const pathMatch = match.match(/["':>\s]([^"'<\n]+\.[a-zA-Z]{1,10})$/)
				if (pathMatch) filesModified.add(pathMatch[1].trim())
			}
		}

		// Extract commands
		const cmdPatterns = text.match(/(?:execute_command|command)["':>\s]+([^"'<\n]+)/gi)
		if (cmdPatterns) {
			for (const match of cmdPatterns) {
				const cmdMatch = match.match(/["':>\s]([^"'<\n]+)$/)
				if (cmdMatch) commandsExecuted.push(cmdMatch[1].trim())
			}
		}
	}

	// Get last assistant message as the final conclusion
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			finalConclusion = getTextContent(messages[i].content)
			break
		}
	}

	if (filesModified.size > 0) {
		parts.push(`Files modified: ${Array.from(filesModified).join(", ")}`)
	}

	if (commandsExecuted.length > 0) {
		parts.push(`Commands executed: ${commandsExecuted.slice(-5).join(", ")}`)
	}

	if (finalConclusion) {
		// Truncate conclusion to fit within budget
		const remainingBudget = maxResultChars - parts.join("\n").length - 20
		if (remainingBudget > 100) {
			const truncatedConclusion =
				finalConclusion.length > remainingBudget
					? finalConclusion.slice(0, remainingBudget) + "..."
					: finalConclusion
			parts.push(`Conclusion: ${truncatedConclusion}`)
		}
	}

	let result = parts.join("\n")
	if (result.length > maxResultChars) {
		result = result.slice(0, maxResultChars - 3) + "..."
	}

	return result
}
