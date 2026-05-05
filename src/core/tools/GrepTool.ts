import path from "path"

import { type ClineSayTool } from "@njust-ai-cj/types"

import { Task } from "../task/Task"
import { validateRegexPattern } from "../../utils/safeRegex"
import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { regexSearchFiles } from "../../services/ripgrep"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks, type ValidationResult } from "./BaseTool"

interface GrepParams {
	pattern: string
	path?: string
	include?: string
	exclude?: string
	contextLines?: number
}

export class GrepTool extends BaseTool<"grep"> {
	readonly name = "grep" as const

	override isConcurrencySafe(): boolean {
		return true
	}

	override isReadOnly(): boolean {
		return true
	}

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Partial<{pattern: string; path?: string; include?: string; exclude?: string; contextLines?: number}>): boolean {
		return typeof partial.pattern === "string" && partial.pattern.length > 0
	}

	override userFacingName(): string {
		return "Grep"
	}

	override get searchHint(): string | undefined {
		return "regex text search grep ripgrep pattern"
	}

	override validateInput(params: GrepParams): ValidationResult {
		if (!params.pattern || params.pattern.trim() === "") {
			return { valid: false, error: "Search pattern is required and cannot be empty." }
		}
		const safety = validateRegexPattern(params.pattern)
		if (!safety.valid) {
			return { valid: false, error: `Unsafe regex: ${safety.reason}` }
		}
		return { valid: true }
	}

	async execute(params: GrepParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		const pattern = params.pattern
		const relDirPath = params.path && params.path.trim().length > 0 ? params.path : "."
		const include = params.include || undefined
		const exclude = params.exclude || undefined
		const contextLines = params.contextLines

		task.consecutiveMistakeCount = 0

		const absolutePath = path.resolve(task.cwd, relDirPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath),
			regex: pattern,
			filePattern: include,
			isOutsideWorkspace,
		}

		try {
			// Build file pattern: combine include/exclude
			const filePattern = include
			// Note: ripgrep --glob supports negation with '!' prefix
			// If exclude is provided but no include, we still pass exclude as a negated glob
			// However regexSearchFiles only supports a single glob; for exclude we would need
			// to extend it. For now, use include as the file pattern.

			const results = await regexSearchFiles(
				task.cwd,
				absolutePath,
				pattern,
				filePattern,
				task.rooIgnoreController,
			)

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: results } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(results)
		} catch (error) {
			await handleError("grep search", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"grep">): Promise<void> {
		const params = (block.nativeArgs || block.params) as Partial<GrepParams>
		const relDirPath = params?.path
		const pattern = params?.pattern

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			regex: pattern ?? "",
			filePattern: params?.include ?? "",
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const grepTool = new GrepTool()
