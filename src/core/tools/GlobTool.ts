import * as path from "path"

import { type ClineSayTool } from "@njust-ai/types"
import { glob } from "glob"
import { z } from "zod"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface GlobParams {
	pattern: string
	path?: string
}

const MAX_RESULTS = 2000

export class GlobTool extends BaseTool<"glob"> {
	readonly name = "glob" as const

	override readonly maxResultSizeChars = 50_000

	override isConcurrencySafe(): boolean {
		return true
	}

	override isReadOnly(): boolean {
		return true
	}

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Partial<{pattern: string; path?: string}>): boolean {
		return typeof partial.pattern === "string" && partial.pattern.length > 0
	}

	override userFacingName(): string {
		return "Glob"
	}

	override get searchHint(): string | undefined {
		return "glob file pattern match find"
	}

	protected override get inputSchema() {
		return z.object({
			pattern: z.string().min(1, "Glob pattern is required"),
			path: z.string().optional(),
		})
	}

	override async execute(params: GlobParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pattern } = params
		const rawPath = params.path
		const relDir = typeof rawPath === "string" ? rawPath.trim() : ""
		const effectivePath = relDir || "."
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, effectivePath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
			if (isOutsideWorkspace) {
				pushToolResult("Access denied: path is outside the workspace")
				return
			}

			// Run glob – respects .gitignore by default (glob v11)
			const filteredMatches = await glob(pattern, {
				cwd: absolutePath,
				nodir: true,
				dot: true,
				posix: true,
			})

			// Limit results
			const limited = filteredMatches.length > MAX_RESULTS
			const results = limited ? filteredMatches.slice(0, MAX_RESULTS) : filteredMatches

			// Sort results alphabetically
			results.sort((a, b) => a.localeCompare(b))

			// Build result text
			let resultText: string
			if (results.length === 0) {
				resultText = `No files matched the pattern "${pattern}" in ${getReadablePath(task.cwd, effectivePath)}.`
			} else {
				const header = limited
					? `Found ${filteredMatches.length} files matching "${pattern}" (showing first ${MAX_RESULTS}):\n`
					: `Found ${results.length} file(s) matching "${pattern}":\n`
				resultText = header + results.join("\n")
			}

			const sharedMessageProps: ClineSayTool = {
				tool: "listFilesRecursive",
				path: getReadablePath(task.cwd, effectivePath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: resultText,
			} satisfies ClineSayTool)

			const didApprove = await askApproval("tool", completeMessage)
			if (!didApprove) {
				return
			}

			pushToolResult(resultText)
		} catch (error) {
			await handleError("glob pattern matching", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"glob">): Promise<void> {
		const _pattern: string | undefined = (block.nativeArgs as Record<string, UnsafeAny>)?.pattern ?? block.params.path
		const relPath: string | undefined = (block.nativeArgs as Record<string, UnsafeAny>)?.path ?? block.params.path

		const absolutePath = relPath ? path.resolve(task.cwd, relPath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "listFilesRecursive",
			path: getReadablePath(task.cwd, relPath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const globTool = new GlobTool()
