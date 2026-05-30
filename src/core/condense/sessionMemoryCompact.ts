/**
 * Cross-session Memory Summary
 *
 * Extracts and preserves key knowledge from the current session
 * for injection into subsequent sessions. This prevents the user
 * from having to re-explain context when starting a new conversation.
 *
 * Inspired by Claude Code's sessionMemoryCompact.ts which maintains
 * a structured summary of session activities.
 */

import * as fs from "fs/promises"
import * as path from "path"

import { type ApiMessage } from "../task-persistence"
import type { TypedBlock } from "../assistant-message/types"

// ─── SessionMemorySummary: structured summary for cross-session persistence ───

export interface SessionMemorySummary {
	sessionId: string
	timestamp: number
	summary: string // LLM-generated session summary
	filesModified: string[] // files that were modified
	filesRead: string[] // key files that were read
	toolsUsed: string[] // tools that were invoked
	keyDecisions: string[] // important decisions made
	unresolvedIssues: string[] // issues left unresolved
	tokenCount: number // estimated tokens for this summary
}

/** Maximum tokens for a session summary */
const MAX_SESSION_SUMMARY_TOKENS = 4000

/** Maximum number of session memories to retain */
const MAX_RETAINED_SESSIONS = 5

/** Approximate characters per token for estimation */
const CHARS_PER_TOKEN = 4

/** Directory name for session memory storage */
export const SESSION_MEMORIES_DIR = ".njust-ai/session-memories"

// ─── Original SessionMemory interface (kept for backward compatibility) ───

export interface SessionMemory {
	/** Files modified during this session */
	modifiedFiles: string[]
	/** Key architectural/design decisions made */
	decisions: string[]
	/** Tasks that were started but not completed */
	pendingTasks: string[]
	/** Code patterns or conventions discovered */
	discoveredPatterns: string[]
	/** Errors encountered and their resolutions */
	errorResolutions: Array<{ error: string; resolution: string }>
	/** Session timestamp */
	timestamp: number
}

/**
 * Build a prompt section from session memory for injection into the next session.
 */
export function buildSessionMemoryPrompt(memory: SessionMemory): string {
	const sections: string[] = ["## Previous Session Context"]

	if (memory.modifiedFiles.length > 0) {
		sections.push(`**Modified files:** ${memory.modifiedFiles.join(", ")}`)
	}

	if (memory.decisions.length > 0) {
		sections.push(`**Key decisions:**\n${memory.decisions.map((d) => `- ${d}`).join("\n")}`)
	}

	if (memory.pendingTasks.length > 0) {
		sections.push(`**Pending tasks:**\n${memory.pendingTasks.map((t) => `- ${t}`).join("\n")}`)
	}

	if (memory.discoveredPatterns.length > 0) {
		sections.push(`**Discovered patterns:**\n${memory.discoveredPatterns.map((p) => `- ${p}`).join("\n")}`)
	}

	if (memory.errorResolutions.length > 0) {
		sections.push(
			`**Error resolutions:**\n${memory.errorResolutions.map((e) => `- ${e.error} → ${e.resolution}`).join("\n")}`,
		)
	}

	return sections.filter(Boolean).join("\n\n")
}

/**
 * Extract session memory from conversation messages.
 * Analyzes assistant messages for file modifications, decisions, and patterns.
 */
export function extractSessionMemory(messages: Array<{ role: string; content: string }>): SessionMemory {
	const memory: SessionMemory = {
		modifiedFiles: [],
		decisions: [],
		pendingTasks: [],
		discoveredPatterns: [],
		errorResolutions: [],
		timestamp: Date.now(),
	}

	for (const msg of messages) {
		if (msg.role === "assistant") {
			// Extract modified files from tool use patterns
			extractModifiedFiles(msg.content, memory.modifiedFiles)
			// Extract decisions from explicit decision language
			extractDecisions(msg.content, memory.decisions)
		}
	}

	// Deduplicate
	memory.modifiedFiles = [...new Set(memory.modifiedFiles)]
	memory.decisions = [...new Set(memory.decisions)]

	return memory
}

// Pre-compiled regex patterns for session memory extraction.
const WRITE_PATTERNS: RegExp[] = [
	/(?:write_to_file|apply_diff|create_file).*?(?:path|file)['":\s]+([^\s'"<>]+\.\w{1,10})/gi,
	/(?:Created|Modified|Updated|Wrote to)\s+[`']?([^\s`']+\.\w{1,10})[`']?/gi,
]

const DECISION_PATTERNS: RegExp[] = [
	/(?:I(?:'ll| will) (?:use|choose|go with|implement|opt for))\s+(.{10,100}?)(?:\.|$)/gim,
	/(?:decided to|decision:|approach:)\s+(.{10,100}?)(?:\.|$)/gim,
]

const READ_FILE_PATTERNS: RegExp[] = [
	/(?:read_file|search_files|list_files).*?(?:path|file)['": \s]+([^\s'"<>]+\.\w{1,10})/gi,
	/(?:Reading|Searched|Viewing)\s+[`']?([^\s`']+\.\w{1,10})[`']?/gi,
]

const TOOLS_USED_PATTERN =
	/(?:use_mcp_tool|execute_command|read_file|write_to_file|apply_diff|search_files|list_files|ask_followup_question|attempt_completion|browser_action|create_file)/gi

const UNRESOLVED_PATTERNS: RegExp[] = [
	/(?:TODO|FIXME|HACK|WORKAROUND|unresolved|still need to|hasn't been|not yet)\s*:?\s*(.{10,120}?)(?:\.|$)/gim,
	/(?:issue|problem|bug)\s+(?:remains|persists|still)\s+(.{10,120}?)(?:\.|$)/gim,
]

/**
 * Extract file paths that were modified (written to, applied diffs).
 */
function extractModifiedFiles(content: string, files: string[]): void {
	for (const pattern of WRITE_PATTERNS) {
		pattern.lastIndex = 0
		let match
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) {
				files.push(match[1])
			}
		}
	}
}

/**
 * Extract key decisions from assistant messages.
 */
function extractDecisions(content: string, decisions: string[]): void {
	for (const pattern of DECISION_PATTERNS) {
		pattern.lastIndex = 0
		let match
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) {
				decisions.push(match[1].trim())
			}
		}
	}
}

/**
 * Merge multiple session memories (e.g., when loading history).
 * More recent sessions take priority for conflicting information.
 */
export function mergeSessionMemories(memories: SessionMemory[]): SessionMemory {
	if (memories.length === 0) {
		return {
			modifiedFiles: [],
			decisions: [],
			pendingTasks: [],
			discoveredPatterns: [],
			errorResolutions: [],
			timestamp: Date.now(),
		}
	}

	// Sort by timestamp, newest first
	const sorted = [...memories].sort((a, b) => b.timestamp - a.timestamp)

	return {
		modifiedFiles: [...new Set(sorted.flatMap((m) => m.modifiedFiles))],
		decisions: sorted.flatMap((m) => m.decisions).slice(0, 20), // Keep last 20 decisions
		pendingTasks: sorted[0]!.pendingTasks, // Only from most recent session
		discoveredPatterns: [...new Set(sorted.flatMap((m) => m.discoveredPatterns))].slice(0, 10),
		errorResolutions: sorted.flatMap((m) => m.errorResolutions).slice(0, 10),
		timestamp: sorted[0]!.timestamp,
	}
}

/** Maximum character budget for session memory prompt injection */
const MAX_SESSION_MEMORY_CHARS = 3000

/**
 * Build a budget-constrained session memory prompt.
 * Ensures the injected context doesn't exceed the token budget.
 */
export function buildBudgetedSessionMemoryPrompt(memory: SessionMemory): string {
	const full = buildSessionMemoryPrompt(memory)
	if (full.length <= MAX_SESSION_MEMORY_CHARS) {
		return full
	}

	// Prioritize: modified files > pending tasks > decisions > patterns > error resolutions
	const prioritized: SessionMemory = {
		...memory,
		decisions: memory.decisions.slice(0, 5),
		discoveredPatterns: memory.discoveredPatterns.slice(0, 3),
		errorResolutions: memory.errorResolutions.slice(0, 3),
	}

	const reduced = buildSessionMemoryPrompt(prioritized)
	if (reduced.length <= MAX_SESSION_MEMORY_CHARS) {
		return reduced
	}

	// Final fallback: just files and pending tasks
	return buildSessionMemoryPrompt({
		...memory,
		decisions: [],
		discoveredPatterns: [],
		errorResolutions: [],
	}).slice(0, MAX_SESSION_MEMORY_CHARS)
}

// ─── SessionMemorySummary functions: generate, persist, load, format ───

/**
 * Estimate token count for a string (rough approximation).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Extract text content from an ApiMessage's content field.
 */
function getMessageText(msg: ApiMessage): string {
	if (typeof msg.content === "string") {
		return msg.content
	}
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((block) => {
				if (typeof block === "string") return block
				const b = block as unknown as TypedBlock
				if (b.type === "text" && typeof b.text === "string") return b.text!
				return ""
			})
			.join("\n")
	}
	return ""
}

/**
 * Extract file paths that were read (read_file / search patterns).
 */
function extractReadFiles(content: string): string[] {
	const files: string[] = []
	for (const pattern of READ_FILE_PATTERNS) {
		pattern.lastIndex = 0
		let match
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) files.push(match[1])
		}
	}
	return files
}

/**
 * Extract tool names used in assistant messages.
 */
function extractToolsUsed(content: string): string[] {
	const tools: string[] = []
	TOOLS_USED_PATTERN.lastIndex = 0
	let match
	while ((match = TOOLS_USED_PATTERN.exec(content)) !== null) {
		tools.push(match[0].toLowerCase())
	}
	return tools
}

/**
 * Extract unresolved issues from the conversation.
 */
function extractUnresolvedIssues(content: string): string[] {
	const issues: string[] = []
	for (const pattern of UNRESOLVED_PATTERNS) {
		pattern.lastIndex = 0
		let match
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) issues.push(match[1].trim())
		}
	}
	return issues
}

/**
 * Generate a structured summary from the current conversation.
 */
export function generateSessionSummary(messages: ApiMessage[], taskId: string): SessionMemorySummary {
	const filesModified: string[] = []
	const filesRead: string[] = []
	const toolsUsed: string[] = []
	const keyDecisions: string[] = []
	const unresolvedIssues: string[] = []
	const summaryParts: string[] = []

	for (const msg of messages) {
		const text = getMessageText(msg)
		if (!text) continue

		if (msg.role === "assistant") {
			extractModifiedFiles(text, filesModified)
			filesRead.push(...extractReadFiles(text))
			toolsUsed.push(...extractToolsUsed(text))
			extractDecisions(text, keyDecisions)
			unresolvedIssues.push(...extractUnresolvedIssues(text))
		}

		// Collect first user message as task description
		if (msg.role === "user" && summaryParts.length === 0) {
			const truncated = text.slice(0, 300)
			summaryParts.push(`Task: ${truncated}`)
		}
	}

	// Build summary text from collected info
	if (filesModified.length > 0) {
		summaryParts.push(`Modified ${filesModified.length} files.`)
	}
	if (keyDecisions.length > 0) {
		summaryParts.push(`Made ${keyDecisions.length} key decisions.`)
	}
	if (unresolvedIssues.length > 0) {
		summaryParts.push(`${unresolvedIssues.length} issues remain unresolved.`)
	}

	const summary = summaryParts.join(" ")
	const deduped = {
		filesModified: [...new Set(filesModified)],
		filesRead: [...new Set(filesRead)].slice(0, 30),
		toolsUsed: [...new Set(toolsUsed)],
		keyDecisions: [...new Set(keyDecisions)].slice(0, 15),
		unresolvedIssues: [...new Set(unresolvedIssues)].slice(0, 10),
	}

	// Truncate summary to fit within token budget
	let finalSummary = summary
	const totalText = JSON.stringify({ summary, ...deduped })
	if (estimateTokens(totalText) > MAX_SESSION_SUMMARY_TOKENS) {
		const maxSummaryChars = MAX_SESSION_SUMMARY_TOKENS * CHARS_PER_TOKEN - (totalText.length - summary.length)
		finalSummary = summary.slice(0, Math.max(100, maxSummaryChars))
	}

	return {
		sessionId: taskId,
		timestamp: Date.now(),
		summary: finalSummary,
		...deduped,
		tokenCount: estimateTokens(JSON.stringify({ summary: finalSummary, ...deduped })),
	}
}

/**
 * Persist a session summary to disk.
 * Stored in the workspace's .njust-ai/session-memories/ directory.
 */
export async function persistSessionMemory(
	summary: SessionMemorySummary,
	workspaceDir: string,
): Promise<void> {
	const dir = path.join(workspaceDir, SESSION_MEMORIES_DIR)
	await fs.mkdir(dir, { recursive: true })

	const filename = `session-${summary.timestamp}-${summary.sessionId.slice(0, 8)}.json`
	const filePath = path.join(dir, filename)
	// Atomic write: write to temp file then rename to avoid partial writes on crash.
	const tmpPath = filePath + ".tmp"
	await fs.writeFile(tmpPath, JSON.stringify(summary, null, 2), "utf-8")
	await fs.rename(tmpPath, filePath)

	// Prune old sessions beyond MAX_RETAINED_SESSIONS
	await pruneOldSessions(dir)
}

/**
 * Remove oldest session memory files if count exceeds MAX_RETAINED_SESSIONS.
 */
async function pruneOldSessions(dir: string): Promise<void> {
	try {
		const files = await fs.readdir(dir)
		const jsonFiles = files
			.filter((f) => f.startsWith("session-") && f.endsWith(".json"))
			// Sort by numeric timestamp (filename: session-{ts}-{id}.json).
			// Lexicographic sort works only when timestamps have equal digit counts.
			.sort((a, b) => {
				const tsA = parseInt(a.split("-")[1]!, 10) || 0
				const tsB = parseInt(b.split("-")[1]!, 10) || 0
				return tsA - tsB
			})

		if (jsonFiles.length > MAX_RETAINED_SESSIONS) {
			const toRemove = jsonFiles.slice(0, jsonFiles.length - MAX_RETAINED_SESSIONS)
			for (const file of toRemove) {
				await fs.unlink(path.join(dir, file))
			}
		}
	} catch {
		// Silently ignore pruning errors
	}
}

/**
 * Load the most recent session memories from disk.
 */
export async function loadSessionMemories(
	workspaceDir: string,
	maxCount: number = MAX_RETAINED_SESSIONS,
): Promise<SessionMemorySummary[]> {
	const dir = path.join(workspaceDir, SESSION_MEMORIES_DIR)

	try {
		const files = await fs.readdir(dir)
		const jsonFiles = files
			.filter((f) => f.startsWith("session-") && f.endsWith(".json"))
			.sort()
			.reverse() // newest first
			.slice(0, maxCount)

		const memories: SessionMemorySummary[] = []
		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(dir, file), "utf-8")
				const parsed = JSON.parse(content) as SessionMemorySummary
				memories.push(parsed)
			} catch {
				// Skip corrupted files
			}
		}

		return memories
	} catch {
		// Directory doesn't exist or can't be read
		return []
	}
}

/**
 * Format session memories for injection into system prompt.
 */
export function formatSessionMemoriesForPrompt(
	memories: SessionMemorySummary[],
	tokenBudget: number,
): string {
	if (memories.length === 0) return ""

	const sections: string[] = []
	let currentTokens = 0

	for (const memory of memories) {
		const lines: string[] = []
		const date = new Date(memory.timestamp).toISOString().slice(0, 19).replace("T", " ")
		lines.push(`### Session: ${date} (${memory.sessionId.slice(0, 8)})`)

		if (memory.summary) {
			lines.push(memory.summary)
		}

		if (memory.filesModified.length > 0) {
			lines.push(`**Modified files:** ${memory.filesModified.join(", ")}`)
		}

		if (memory.keyDecisions.length > 0) {
			lines.push(`**Key decisions:**`)
			for (const d of memory.keyDecisions.slice(0, 5)) {
				lines.push(`- ${d}`)
			}
		}

		if (memory.unresolvedIssues.length > 0) {
			lines.push(`**Unresolved issues:**`)
			for (const issue of memory.unresolvedIssues.slice(0, 5)) {
				lines.push(`- ${issue}`)
			}
		}

		if (memory.toolsUsed.length > 0) {
			lines.push(`**Tools used:** ${memory.toolsUsed.join(", ")}`)
		}

		const sectionText = lines.join("\n")
		const sectionTokens = estimateTokens(sectionText)

		if (currentTokens + sectionTokens > tokenBudget) {
			// Try a minimal version with just summary + files
			const minimal = [
				`### Session: ${date} (${memory.sessionId.slice(0, 8)})`,
				memory.summary,
				memory.filesModified.length > 0
					? `**Modified:** ${memory.filesModified.join(", ")}`
					: "",
			]
				.filter(Boolean)
				.join("\n")
			const minTokens = estimateTokens(minimal)
			if (currentTokens + minTokens <= tokenBudget) {
				sections.push(minimal)
				currentTokens += minTokens
			}
			break
		}

		sections.push(sectionText)
		currentTokens += sectionTokens
	}

	return sections.join("\n\n")
}

/**
 * Generate a concise "While you were away..." summary from recent messages.
 * Triggered when the user returns from a period of inactivity.
 *
 * @param messages - Recent conversation messages (since last user interaction)
 * @returns A short 1-3 sentence summary of what happened
 */
export function generateAwaySummary(
	messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
): string {
	if (messages.length === 0) return ""

	const parts: string[] = []
	let fileCount = 0
	let decisionCount = 0
	let errorCount = 0
	let lastTask = ""

	for (const msg of messages) {
		if (msg.role !== "assistant") continue
		const text = typeof msg.content === "string" ? msg.content : msg.content.map((b) => b.text ?? "").join(" ")

		// Count file modifications
		const files = text.match(/(?:write_to_file|apply_diff|create_file)/g)
		if (files) fileCount += files.length

		// Count decisions
		const decisions = text.match(/(?:decided to|I'll use|approach:|choice:)/gi)
		if (decisions) decisionCount += decisions.length

		// Count errors
		const errors = text.match(/\b(?:error|failed|exception)\b/gi)
		if (errors) errorCount += errors.length

		// Extract last task description
		const taskMatch = text.match(/attempt_completion.*?(?:result|output)["':\s]+([^"'\n]{20,100})/is)
		if (taskMatch) lastTask = taskMatch[1]!
	}

	if (fileCount > 0) parts.push(`Modified ${fileCount} file${fileCount > 1 ? "s" : ""}.`)
	if (decisionCount > 0) parts.push(`Made ${decisionCount} decision${decisionCount > 1 ? "s" : ""}.`)
	if (errorCount > 0) parts.push(`Encountered ${errorCount} error${errorCount > 1 ? "s" : ""} that were resolved.`)
	if (lastTask) parts.push(`Completed: ${lastTask.slice(0, 120)}`)

	return parts.length > 0
		? `**While you were away:** ${parts.join(" ")}`
		: "**While you were away:** Work continued on your previous request."
}
