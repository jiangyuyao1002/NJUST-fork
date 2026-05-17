import * as fs from "fs"
import { ApiMessage } from "../task-persistence/apiMessages"

/** Maximum number of files to restore after compaction */
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5

/** Total token budget for all restored file content */
export const POST_COMPACT_TOKEN_BUDGET = 50_000

/** Maximum tokens per individual restored file */
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000

/** Maximum tokens per restored skill content */
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000

/** Total token budget for skill content restoration */
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

type AsyncAgentStatus = {
	description?: string
	status: "running" | "completed" | "failed"
	summary?: string | null
	error?: string | null
}

export type RestoreOptions = {
	/** Paths of recently accessed files to re-inject after compaction */
	recentFiles?: string[]
	/** Active skill names/paths with their content to restore */
	activeSkills?: Array<{ name: string; path?: string; content: string }>
	/** MCP instructions delta to re-announce */
	mcpDelta?: string
	/** Deferred tools delta to re-announce (JSON text) */
	toolsDelta?: string
	/** Agent listing delta to re-announce */
	agentListingDelta?: string
	/** Plan file content and path (if user is working with a plan) */
	planFile?: { path: string; content: string } | null
	/** Whether the user is in plan mode */
	isPlanMode?: boolean
	/** Status of background async agents */
	asyncAgents?: AsyncAgentStatus[]
	/** Messages preserved post-compaction (skip re-injecting files visible here) */
	preservedMessages?: ApiMessage[]
}

/**
 * Estimate token count for a given text (~4 chars per token).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Truncate content to fit within a token budget, keeping head and tail
 * with a truncation marker in between.
 */
function truncateToTokenBudget(content: string, maxTokens: number): string {
	const maxChars = maxTokens * 4
	if (content.length <= maxChars) return content
	const headChars = Math.floor(maxChars * 0.6)
	const tailChars = Math.floor(maxChars * 0.3)
	const omittedTokens = estimateTokens(content) - maxTokens
	return (
		content.slice(0, headChars) +
		`\n\n... [truncated: ${omittedTokens} tokens omitted] ...\n\n` +
		content.slice(-tailChars)
	)
}

/**
 * Post-compact context restoration: reads recent files from disk and injects
 * their content (within a token budget) back into the conversation after compaction.
 * Also restores plan state, plan mode instructions, async agent status,
 * skill content, and deferred tools/MCP deltas.
 *
 * Each restoration category has its own token budget to prevent any single
 * category from consuming the entire post-compact headroom.
 */
/**
 * Scan preserved messages for Read tool_use blocks and collect their file_path
 * inputs (normalized). Used to skip re-injecting files already visible in the
 * preserved tail after compaction.
 */
export function collectReadToolFilePaths(preservedMessages: ApiMessage[]): Set<string> {
	const paths = new Set<string>()
	for (const msg of preservedMessages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
		for (const block of msg.content as UnsafeAny[]) {
			if (block.type !== "tool_use") continue
			const name = block.name || ""
			// Only consider read-like tools — writes are worth re-injecting
			if (!/^(read_file|search_files|grep_search|list_files|glob)$/.test(name)) continue
			const input = block.input
			if (input && typeof input === "object") {
				const filePath = input.filePath || input.path || input.file_path
				if (typeof filePath === "string" && filePath.length > 0) {
					paths.add(filePath)
				}
			}
		}
	}
	return paths
}

export function postCompactRestore(messages: ApiMessage[], options?: RestoreOptions): ApiMessage[] {
	if (!options) return messages

	const restoredParts: string[] = []

	// 1. File restoration (budget: POST_COMPACT_TOKEN_BUDGET, per-file: POST_COMPACT_MAX_TOKENS_PER_FILE)
	if (options.recentFiles && options.recentFiles.length > 0) {
		// Dedup: skip files already visible in preserved messages
		const preservedPaths = options.preservedMessages
			? collectReadToolFilePaths(options.preservedMessages)
			: new Set<string>()

		let fileTokensUsed = 0
		const filesToRestore = options.recentFiles
			.filter((f) => !preservedPaths.has(f))
			.slice(0, POST_COMPACT_MAX_FILES_TO_RESTORE)
		for (const filePath of filesToRestore) {
			if (fileTokensUsed >= POST_COMPACT_TOKEN_BUDGET) break
			try {
				const content = fs.readFileSync(filePath, "utf-8")
				const remainingBudget = Math.min(
					POST_COMPACT_MAX_TOKENS_PER_FILE,
					POST_COMPACT_TOKEN_BUDGET - fileTokensUsed,
				)
				const truncated = truncateToTokenBudget(content, remainingBudget)
				const tokens = estimateTokens(truncated)
				fileTokensUsed += tokens
				restoredParts.push(`### File: ${filePath}\n\`\`\`\n${truncated}\n\`\`\``)
			} catch {
				restoredParts.push(`### File: ${filePath}\n(file no longer available)`)
			}
		}
	}

	// 2. Skill content restoration (budget: POST_COMPACT_SKILLS_TOKEN_BUDGET, per-skill: POST_COMPACT_MAX_TOKENS_PER_SKILL)
	if (options.activeSkills && options.activeSkills.length > 0) {
		let skillTokensUsed = 0
		// Sort by recency (assumes caller passes most-recent-first)
		for (const skill of options.activeSkills) {
			if (skillTokensUsed >= POST_COMPACT_SKILLS_TOKEN_BUDGET) break
			const remainingBudget = Math.min(
				POST_COMPACT_MAX_TOKENS_PER_SKILL,
				POST_COMPACT_SKILLS_TOKEN_BUDGET - skillTokensUsed,
			)
			const truncated = truncateToTokenBudget(skill.content, remainingBudget)
			const tokens = estimateTokens(truncated)
			skillTokensUsed += tokens
			const label = skill.path ? `${skill.name} (${skill.path})` : skill.name
			restoredParts.push(
				`### Active Skill: ${label}\n\`\`\`\n${truncated}\n\`\`\`\n` +
				`[... skill content may be truncated; re-read the skill file if you need full context]`,
			)
		}
	}

	// 3. Plan file restoration
	if (options.planFile?.content) {
		const truncated = truncateToTokenBudget(options.planFile.content, POST_COMPACT_MAX_TOKENS_PER_FILE)
		restoredParts.push(`### Plan File: ${options.planFile.path}\n\`\`\`\n${truncated}\n\`\`\``)
	}

	// 4. Plan mode reminder
	if (options.isPlanMode) {
		restoredParts.push(
			`### Plan Mode Active\n` +
			`The user is in plan mode. Do NOT make edits or run tools without explicit approval. ` +
			`Present your plan and wait for the user to approve before implementing.`,
		)
	}

	// 5. Async agent status
	if (options.asyncAgents && options.asyncAgents.length > 0) {
		for (const agent of options.asyncAgents) {
			const desc = agent.description ? ` — ${agent.description}` : ""
			const detail =
				agent.status === "running"
					? ` (in progress${agent.summary ? `: ${agent.summary}` : ""})`
					: agent.status === "failed"
						? ` (failed${agent.error ? `: ${agent.error}` : ""})`
						: " (completed, results may be available)"
			restoredParts.push(`### Background Agent${desc}${detail}`)
		}
	}

	// 6. MCP instructions delta
	if (options.mcpDelta && options.mcpDelta.trim().length > 0) {
		const mcpText = options.mcpDelta.trim().slice(0, 2000)
		restoredParts.push(`### MCP Context\n${mcpText}`)
	}

	// 7. Deferred tools delta
	if (options.toolsDelta && options.toolsDelta.trim().length > 0) {
		const toolsText = options.toolsDelta.trim().slice(0, 2000)
		restoredParts.push(`### Available Tools Update\n${toolsText}`)
	}

	// 8. Agent listing delta
	if (options.agentListingDelta && options.agentListingDelta.trim().length > 0) {
		const agentText = options.agentListingDelta.trim().slice(0, 2000)
		restoredParts.push(`### Available Agents\n${agentText}`)
	}

	if (restoredParts.length === 0) return messages

	const restoreMessage: ApiMessage = {
		role: "user",
		content:
			`<system-reminder>\n` +
			`[Context restored after compaction — these resources were recently used and are re-injected so you don't have to re-read them]\n\n` +
			`${restoredParts.join("\n\n")}\n` +
			`</system-reminder>`,
		ts: Date.now(),
	}

	return [...messages, restoreMessage]
}
