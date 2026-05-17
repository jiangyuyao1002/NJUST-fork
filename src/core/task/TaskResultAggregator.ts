/**
 * Task Result Aggregator
 *
 * Aggregates results from multiple subtasks into a structured summary
 * for injection back into the parent task's context.
 *
 * Strategies:
 * - Code modifications: preserve file paths + diff summaries
 * - Search/analysis: preserve conclusions + key references
 * - Failed subtasks: preserve error reason + suggested alternatives
 */

import type { ApiMessage } from "../task-persistence/apiMessages"

export interface SubtaskResult {
	taskId: string
	taskDescription: string
	status: "completed" | "failed" | "partial"
	resultType: "code_modification" | "search_analysis" | "command_execution" | "general"
	filesModified: string[]
	filesRead: string[]
	commandsExecuted: string[]
	summary: string
	error?: string
	duration: number // ms
}

export interface AggregatedResult {
	subtaskCount: number
	successCount: number
	failureCount: number
	sections: AggregatedSection[]
	totalTokens: number
}

interface AggregatedSection {
	title: string
	content: string
	tokenCount: number
}

/** Maximum tokens for the entire aggregated result */
const MAX_AGGREGATED_TOKENS = 8000

/** Maximum tokens per subtask summary */
const MAX_PER_SUBTASK_TOKENS = 2000

/**
 * Estimate token count from text using a rough 4-chars-per-token heuristic.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Extract text content from an ApiMessage content field.
 * Handles both plain string and Anthropic content-block array formats.
 */
function getTextContent(content: UnsafeAny): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return (content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text!)
			.join("\n")
	}
	return ""
}

export class TaskResultAggregator {
	private results: SubtaskResult[] = []

	/**
	 * Add a subtask result to the aggregation queue.
	 */
	addResult(result: SubtaskResult): void {
		this.results.push(result)
	}

	/**
	 * Get all currently collected results.
	 */
	getResults(): readonly SubtaskResult[] {
		return this.results
	}

	/**
	 * Classify a subtask result based on its conversation messages.
	 *
	 * Analyzes message content to determine the dominant activity type:
	 * - Contains write_to_file / apply_diff → code_modification
	 * - Contains search_files / read_file → search_analysis
	 * - Contains execute_command → command_execution
	 * - Otherwise → general
	 */
	classifyResult(messages: ApiMessage[], _taskDescription: string): SubtaskResult["resultType"] {
		let codeScore = 0
		let searchScore = 0
		let commandScore = 0

		for (const msg of messages) {
			const text = getTextContent(msg.content)
			if (!text) continue

			// Score code modification signals
			if (/write_to_file/i.test(text)) codeScore += 3
			if (/apply_diff/i.test(text)) codeScore += 3
			if (/create_file/i.test(text)) codeScore += 2

			// Score search/analysis signals
			if (/search_files/i.test(text)) searchScore += 2
			if (/read_file/i.test(text)) searchScore += 1
			if (/list_files/i.test(text)) searchScore += 1

			// Score command execution signals
			if (/execute_command/i.test(text)) commandScore += 3
		}

		const maxScore = Math.max(codeScore, searchScore, commandScore)
		if (maxScore === 0) return "general"
		if (codeScore === maxScore) return "code_modification"
		if (commandScore === maxScore) return "command_execution"
		return "search_analysis"
	}

	/**
	 * Generate the aggregated result for injection into parent context.
	 *
	 * Groups subtask results by type, builds structured sections, and
	 * enforces a token budget by proportionally truncating sections.
	 */
	aggregate(): AggregatedResult {
		const sections: AggregatedSection[] = []

		// Group results by type (failed tasks are collected separately regardless of type)
		const codeResults = this.results.filter((r) => r.resultType === "code_modification" && r.status !== "failed")
		const searchResults = this.results.filter((r) => r.resultType === "search_analysis" && r.status !== "failed")
		const commandResults = this.results.filter(
			(r) => r.resultType === "command_execution" && r.status !== "failed",
		)
		const generalResults = this.results.filter((r) => r.resultType === "general" && r.status !== "failed")
		const failedResults = this.results.filter((r) => r.status === "failed")

		// --- Aggregate code modifications ---
		if (codeResults.length > 0) {
			const content = codeResults
				.map((r) => {
					const files = r.filesModified.length > 0 ? r.filesModified.join(", ") : "(no files)"
					const summary = truncateText(r.summary, MAX_PER_SUBTASK_TOKENS * 4)
					return `- ${r.taskDescription}: modified ${files}\n  ${summary}`
				})
				.join("\n")
			sections.push({ title: "Code Changes", content, tokenCount: estimateTokens(content) })
		}

		// --- Aggregate search/analysis results ---
		if (searchResults.length > 0) {
			const content = searchResults
				.map((r) => {
					const summary = truncateText(r.summary, MAX_PER_SUBTASK_TOKENS * 4)
					const refs =
						r.filesRead.length > 0 ? `\n  References: ${r.filesRead.slice(0, 10).join(", ")}` : ""
					return `- ${r.taskDescription}: ${summary}${refs}`
				})
				.join("\n")
			sections.push({ title: "Analysis Results", content, tokenCount: estimateTokens(content) })
		}

		// --- Aggregate command executions ---
		if (commandResults.length > 0) {
			const content = commandResults
				.map((r) => {
					const cmds = r.commandsExecuted.length > 0 ? r.commandsExecuted.join("; ") : "(no commands)"
					const summary = truncateText(r.summary, MAX_PER_SUBTASK_TOKENS * 4)
					return `- ${cmds}: ${summary}`
				})
				.join("\n")
			sections.push({ title: "Command Results", content, tokenCount: estimateTokens(content) })
		}

		// --- Aggregate general results ---
		if (generalResults.length > 0) {
			const content = generalResults
				.map((r) => {
					const summary = truncateText(r.summary, MAX_PER_SUBTASK_TOKENS * 4)
					return `- ${summary}`
				})
				.join("\n")
			sections.push({ title: "Other Results", content, tokenCount: estimateTokens(content) })
		}

		// --- Aggregate failures with recovery suggestions ---
		if (failedResults.length > 0) {
			const content = failedResults
				.map((r) => {
					const errorInfo = r.error ? r.error : "Unknown error"
					return (
						`- FAILED: ${r.taskDescription}\n` +
						`  Error: ${truncateText(errorInfo, 500)}\n` +
						`  Duration: ${(r.duration / 1000).toFixed(1)}s\n` +
						`  Suggestion: Review and retry manually`
					)
				})
				.join("\n")
			sections.push({ title: "Failed Subtasks", content, tokenCount: estimateTokens(content) })
		}

		// --- Apply token budget ---
		this.applyTokenBudget(sections)

		const totalTokens = sections.reduce((sum, s) => sum + s.tokenCount, 0)

		return {
			subtaskCount: this.results.length,
			successCount: this.results.filter((r) => r.status === "completed").length,
			failureCount: this.results.filter((r) => r.status === "failed").length,
			sections,
			totalTokens,
		}
	}

	/**
	 * Format aggregated result as a message string for injection into parent context.
	 */
	formatAsMessage(): string {
		const result = this.aggregate()
		const header = `## Subtask Results (${result.successCount}/${result.subtaskCount} succeeded)`
		const lines = [header, ""]

		for (const section of result.sections) {
			lines.push(`### ${section.title}`)
			lines.push(section.content)
			lines.push("")
		}

		if (result.failureCount > 0) {
			lines.push(
				`> **Note:** ${result.failureCount} subtask(s) failed. See "Failed Subtasks" section for details.`,
			)
			lines.push("")
		}

		return lines.join("\n")
	}

	/**
	 * Reset the aggregator, clearing all collected results.
	 */
	reset(): void {
		this.results = []
	}

	// ─── Private helpers ──────────────────────────────────────────────

	/**
	 * Enforce the MAX_AGGREGATED_TOKENS budget across all sections.
	 * If total tokens exceed the budget, proportionally truncate each section.
	 */
	private applyTokenBudget(sections: AggregatedSection[]): void {
		const totalTokens = sections.reduce((sum, s) => sum + s.tokenCount, 0)
		if (totalTokens <= MAX_AGGREGATED_TOKENS) return

		// Proportionally truncate each section
		const ratio = MAX_AGGREGATED_TOKENS / totalTokens

		for (const section of sections) {
			const targetChars = Math.floor(section.content.length * ratio)
			if (section.content.length > targetChars) {
				section.content = section.content.slice(0, targetChars) + "\n  ...(truncated)"
				section.tokenCount = estimateTokens(section.content)
			}
		}
	}
}

/**
 * Truncate text to a maximum character length, appending "..." if truncated.
 */
function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	return text.slice(0, maxChars - 3) + "..."
}
