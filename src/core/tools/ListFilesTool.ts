import * as path from "path"
import { z } from "zod"

import { type ClineSayTool } from "@njust-ai/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { listFiles } from "../../services/glob/list-files"
import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { isPathUnderBundledCangjieCorpus, isPathPotentiallyUnderCangjieCorpus } from "../../utils/bundledCangjieCorpus"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { toolResultCache } from "./helpers/ToolResultCache"

interface ListFilesParams {
	path: string
	recursive?: boolean
}

export class ListFilesTool extends BaseTool<"list_files"> {
	readonly name = "list_files" as const
	override readonly maxResultSizeChars = 50_000
	override isConcurrencySafe(): boolean {
		return true
	}

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Partial<{path: string; recursive?: boolean}>): boolean {
		return typeof partial.path === "string"
	}

	protected override get inputSchema() {
		return z.object({
			path: z.string().min(1, "path is required"),
			recursive: z.boolean().optional(),
		})
	}

	async execute(params: ListFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const cacheKey = toolResultCache.makeKey("list_files", params)
		const cached = toolResultCache.get(cacheKey)
		if (cached) {
			callbacks.pushToolResult(cached)
			return
		}
		const rawPath = params.path
		const relDirPath =
			typeof rawPath === "string" ? rawPath.trim() : typeof rawPath === "number" ? String(rawPath) : ""
		const effectivePath = relDirPath || "."
		const { recursive } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, effectivePath)
			const extensionPath = task.providerRef.deref()?.context.extensionPath

			const [files, didHitLimit] = await listFiles(absolutePath, recursive || false, 200)
			const { showRooIgnoredFiles = false } = (await task.providerRef.deref()?.getState()) ?? {}

			const result = await formatResponse.formatFilesList(
				absolutePath,
				files,
				didHitLimit,
				task.rooIgnoreController,
				showRooIgnoredFiles,
				task.rooProtectedController,
			)

			if (isPathUnderBundledCangjieCorpus(absolutePath, extensionPath)) {
				toolResultCache.set(cacheKey, result)
				pushToolResult(result)
				return
			}

			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ClineSayTool = {
				tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
				path: getReadablePath(task.cwd, effectivePath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: result } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(result)
		} catch (error) {
			await handleError("listing files", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"list_files">): Promise<void> {
		const relDirPath: string | undefined = block.params.path
		const recursiveRaw: string | undefined = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const extensionPath = task.providerRef.deref()?.context.extensionPath

		if (isPathPotentiallyUnderCangjieCorpus(absolutePath, extensionPath, relDirPath)) {
			return
		}

		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const listFilesTool = new ListFilesTool()
