import { z } from "zod"

import { Task } from "../task/Task"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface BriefParams {
	content: string
	maxLength?: number | null
}

const DEFAULT_MAX_LENGTH = 500

/**
 * BriefTool – summarises / truncates content by keeping the first paragraph,
 * key lines, and the ending while stripping redundancy.
 * If the content is already shorter than maxLength it is returned as-is.
 */
export class BriefTool extends BaseTool<"brief"> {
	readonly name = "brief" as const

	override isConcurrencySafe(): boolean {
		return true
	}

	override isReadOnly(): boolean {
		return true
	}

	override userFacingName(): string {
		return "Brief"
	}

	override get searchHint(): string | undefined {
		return "brief summary summarize truncate"
	}

	override get shouldDefer(): boolean {
		return true
	}

	protected override get inputSchema() {
		return z.object({
			content: z.string().min(1, "content is required"),
			maxLength: z.number().positive().optional().nullable(),
		})
	}

	async execute(params: BriefParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { handleError, pushToolResult } = callbacks

		try {
			const maxLength =
				typeof params.maxLength === "number" && params.maxLength > 0 ? params.maxLength : DEFAULT_MAX_LENGTH

			const content = params.content

			// If already short enough, return as-is
			if (content.length <= maxLength) {
				task.consecutiveMistakeCount = 0
				pushToolResult(content)
				return
			}

			const briefed = briefContent(content, maxLength)
			task.consecutiveMistakeCount = 0
			pushToolResult(briefed)
		} catch (error) {
			await handleError("generating brief", error as Error)
		}
	}
}

/**
 * Simple extractive summarisation:
 * 1. Keep the first paragraph (up to ~40% budget).
 * 2. Scan remaining lines for "key" lines (non-empty, non-comment, containing
 *    keywords / headings / definitions).
 * 3. Append the last few lines as an ending.
 * 4. Join and truncate to maxLength.
 */
function briefContent(text: string, maxLength: number): string {
	const lines = text.split("\n")

	// --- first paragraph ---
	const firstParaEnd = lines.findIndex((l, i) => i > 0 && l.trim() === "")
	const firstParaLines = firstParaEnd > 0 ? lines.slice(0, firstParaEnd) : lines.slice(0, 1)
	const firstPara = firstParaLines.join("\n")

	// budget allocation
	const firstParaBudget = Math.floor(maxLength * 0.4)
	const endBudget = Math.floor(maxLength * 0.2)
	const middleBudget = maxLength - Math.min(firstPara.length, firstParaBudget) - endBudget

	// --- ending ---
	const endLines: string[] = []
	let endLen = 0
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!
		if (endLen + line.length + 1 > endBudget) break
		endLines.unshift(line)
		endLen += line.length + 1
	}

	// --- key lines from the middle ---
	const middleStart = firstParaEnd > 0 ? firstParaEnd + 1 : 1
	const middleEnd = lines.length - endLines.length
	const keyLines: string[] = []
	let keyLen = 0
	for (let i = middleStart; i < middleEnd; i++) {
		const line = lines[i]!
		if (isKeyLine(line)) {
			if (keyLen + line.length + 1 > middleBudget) break
			keyLines.push(line)
			keyLen += line.length + 1
		}
	}

	// --- assemble ---
	const parts: string[] = []
	const trimmedFirst = firstPara.length > firstParaBudget ? firstPara.slice(0, firstParaBudget) + "..." : firstPara
	parts.push(trimmedFirst)

	if (keyLines.length > 0) {
		parts.push("...\n" + keyLines.join("\n"))
	}
	if (endLines.length > 0) {
		parts.push("...\n" + endLines.join("\n"))
	}

	let result = parts.join("\n")
	if (result.length > maxLength) {
		result = result.slice(0, maxLength - 3) + "..."
	}
	return result
}

/** Heuristic: a line is "key" if it looks like a heading, definition, or important statement. */
function isKeyLine(line: string): boolean {
	const trimmed = line.trim()
	if (!trimmed || trimmed.length < 3) return false
	// Markdown headings
	if (/^#{1,6}\s/.test(trimmed)) return true
	// Lines containing colons (key: value) or arrows
	if (/[:=]/.test(trimmed) && trimmed.length < 200) return true
	// Function / class / export definitions
	if (/^(export|function|class|interface|type|const|let|var|def|fn|pub)\b/.test(trimmed)) return true
	// Bullet points
	if (/^[-*]\s/.test(trimmed)) return true
	return false
}

export const briefTool = new BriefTool()
