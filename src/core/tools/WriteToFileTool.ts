import path from "path"
import delay from "delay"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@njust-ai/types"

import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath, createDirectoriesForFile } from "../../utils/fs"
import { stripLineNumbers, everyLineHasLineNumbers } from "../../integrations/misc/extract-text"
import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { logger } from "../../shared/logger"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { z } from "zod"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import {
	cangjiePreflightCheck,
	buildSearchGateWarning,
	CRITICAL_SIGNATURE_MODULES,
	resolveRootPackageName,
} from "./cangjiePreflightCheck"

interface WriteToFileParams {
	path: string
	content: string
}

export class WriteToFileTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const
	override readonly requiresCheckpoint = true

	override isConcurrencySafe(_params?: WriteToFileParams): boolean {
		return true
	}

	override interruptBehavior(): "cancel" | "block" {
		return "block"
	}

	override userFacingName(): string {
		return "Write To File"
	}

	protected override get inputSchema() {
		return z.object({
			path: z.string().min(1, "File path is required"),
			content: z.string(), // allow empty string (clearing file)
		})
	}

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval } = callbacks
		const relPath = params.path
		let newContent = params.content

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))
			await task.diffViewProvider.reset()
			return
		}

		if (newContent === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = allowRooIgnorePathAccess(task.rooIgnoreController, relPath)
		// Guard against excessive file sizes (5 MB limit)
		const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
		if (Buffer.byteLength(newContent, "utf8") > MAX_FILE_SIZE_BYTES) {
			pushToolResult(
				formatResponse.toolError(`Content exceeds maximum file size of ${MAX_FILE_SIZE_BYTES} bytes.`),
			)
			return
		}

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		const isWriteProtected = (await task.rooProtectedController?.isWriteProtected(relPath)) || false

		let fileExists: boolean
		const absolutePath = path.resolve(task.cwd, relPath)
		let previousContent: string | undefined

		if (task.diffViewProvider.editType !== undefined) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		// Create parent directories early for new files to prevent ENOENT errors
		// in subsequent operations (e.g., diffViewProvider.open, fs.readFile)
		if (!fileExists) {
			await createDirectoriesForFile(absolutePath)
		}

		if (absolutePath.toLowerCase().endsWith(".cj") && task.taskMode === "cangjie") {
			const initError = await task.cangjieRuntimePolicy.ensureProjectInitializedForWrite(relPath)
			if (initError) {
				task.recordToolError("write_to_file", initError)
				pushToolResult(formatResponse.toolError(initError))
				await task.diffViewProvider.reset()
				return
			}
		}

		if (newContent.startsWith("```")) {
			newContent = newContent.split("\n").slice(1).join("\n")
		}

		if (newContent.endsWith("```")) {
			newContent = newContent.split("\n").slice(0, -1).join("\n")
		}

		if (!task.api.getModel().id.includes("claude")) {
			newContent = unescapeHtmlEntities(newContent)
		}

		if (task.taskMode === "cangjie") {
			const structureError = await task.cangjieRuntimePolicy.validateProjectStructureForWrite(relPath, newContent)
			if (structureError) {
				task.recordToolError("write_to_file", structureError)
				pushToolResult(formatResponse.toolError(structureError))
				await task.diffViewProvider.reset()
				return
			}
		}

		// Cangjie preflight check: validate .cj files before writing (only in Cangjie mode)
		let cangjiePostWriteWarnings = ""
		if (absolutePath.toLowerCase().endsWith(".cj") && task.taskMode === "cangjie") {
			if (fileExists) {
				try {
					previousContent = await fs.readFile(absolutePath, "utf-8")
				} catch (err) {
					logger.warn("WriteToFileTool", "Pre-read failed (file may be new):", err)
					previousContent = undefined
				}
			}
			const rootPkg = await resolveRootPackageName(task.cwd)
			const preflight = cangjiePreflightCheck(newContent, relPath, task.cwd, rootPkg)
			if (!preflight.pass) {
				task.consecutiveMistakeCount++
				task.didToolFailInCurrentTurn = true
				// Agent-facing: preflight errors are embedded in tool_result sent to the AI,
				// intentionally kept in Chinese as the Cangjie LLM responds better to Chinese technical feedback.
				const errorMsg =
					`仓颉代码预检失败，文件未写入：\n` +
					preflight.errors.map((e) => `- ${e}`).join("\n") +
					`\n\n请修正以上错误后重试。`
				task.recordToolError("write_to_file", errorMsg)
				pushToolResult(formatResponse.toolError(errorMsg))
				await task.diffViewProvider.reset()
				return
			}
			if (preflight.warnings.length > 0) {
				cangjiePostWriteWarnings =
					`\n\n<cangjie_preflight_warnings>\n` +
					preflight.warnings.map((w) => `- ${w}`).join("\n") +
					`\n</cangjie_preflight_warnings>`
			}
			const missingEvidence = task.cangjieRuntimePolicy.getMissingImportEvidence(previousContent, newContent)
			if (missingEvidence.length > 0) {
				const errorMsg =
					`Missing bundled corpus evidence for newly introduced stdlib modules: ${missingEvidence.join(", ")}. ` +
					`Use search_files or read_file against the bundled CangjieCorpus before writing this code.`
				task.recordToolError("write_to_file", errorMsg)
				pushToolResult(formatResponse.toolError(errorMsg))
				await task.diffViewProvider.reset()
				return
			}
			// Search gate: warn if std modules were used without prior search
			const searchGate = buildSearchGateWarning(
				newContent,
				task.cangjieSearchHistory ?? new Set(),
				CRITICAL_SIGNATURE_MODULES,
			)
			if (searchGate) {
				cangjiePostWriteWarnings += searchGate
			}
		}

		const fullPath = relPath ? path.resolve(task.cwd, relPath) : ""
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

		// Block writes outside workspace for safety (path traversal attack prevention)
		if (isOutsideWorkspace) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(
				formatResponse.toolError(
					`Safety: cannot write to path outside workspace: ${getReadablePath(task.cwd, relPath)}`,
				),
			)
			await task.diffViewProvider.reset()
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(task.cwd, relPath),
			content: newContent,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			if (isPreventFocusDisruptionEnabled) {
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
				if (fileExists) {
					const absolutePath = path.resolve(task.cwd, relPath)
					task.diffViewProvider.originalContent = await fs.readFile(absolutePath, "utf-8")
				} else {
					task.diffViewProvider.originalContent = ""
				}

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.reset()
					return
				}

				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				if (!task.diffViewProvider.isEditing) {
					const partialMessage = JSON.stringify(sharedMessageProps)
					await task.ask("tool", partialMessage, true).catch(ignoreAbortError)
					await task.diffViewProvider.open(relPath)
				}

				await task.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					true,
				)

				await delay(300)
				task.diffViewProvider.scrollToFirstDiff()

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					return
				}

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "njust_ai_edited" as RecordSource)
			}

			task.didEditFile = true
			task.cangjieRuntimePolicy.noteWriteApplied(relPath, previousContent, newContent)

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			pushToolResult(message + cangjiePostWriteWarnings)

			await task.diffViewProvider.reset()
			this.resetPartialState()

			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("writing file", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const na = block.nativeArgs as { path?: string; content?: string } | undefined
		const relPath: string | undefined = block.params.path ?? na?.path
		const newContent: string | undefined = block.params.content ?? na?.content

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath) || newContent === undefined) {
			return
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const isPreventFocusDisruptionEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
		)

		if (isPreventFocusDisruptionEnabled) {
			return
		}

		// relPath is guaranteed non-null after hasPathStabilized
		let fileExists: boolean
		const absolutePath = path.resolve(task.cwd, relPath!)

		if (task.diffViewProvider.editType !== undefined) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		// Create parent directories early for new files to prevent ENOENT errors
		// in subsequent operations (e.g., diffViewProvider.open)
		if (!fileExists) {
			await createDirectoriesForFile(absolutePath)
		}

		const isWriteProtected = (await task.rooProtectedController?.isWriteProtected(relPath!)) || false
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(task.cwd, relPath!),
			content: newContent || "",
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)

		if (newContent) {
			if (!task.diffViewProvider.isEditing) {
				await task.diffViewProvider.open(relPath!)
			}

			await task.diffViewProvider.update(
				everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
				false,
			)
		}
	}
}

export const writeToFileTool = new WriteToFileTool()
