import path from "path"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ApplyDiffParams {
	path: string
	diff: string
}

/**
 * @deprecated Prefer ApplyPatchTool (name: "apply_patch") for new model-facing calls.
 * This tool remains registered separately because apply_diff has a different parameter shape.
 */
export class ApplyDiffTool extends BaseTool<"apply_diff"> {
	readonly name = "apply_diff" as const
	override readonly requiresCheckpoint = true

	override interruptBehavior(): "cancel" | "block" {
		return "block"
	}

	override userFacingName(): string {
		return "Apply Diff"
	}

	async execute(params: ApplyDiffParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { path: relPath } = params
		let { diff: diffContent } = params

		if (diffContent && !task.api.getModel().id.includes("claude")) {
			diffContent = unescapeHtmlEntities(diffContent)
		}

		try {
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "path"))
				return
			}

			if (!diffContent) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "diff"))
				return
			}

			const accessAllowed = allowRooIgnorePathAccess(task.rooIgnoreController, relPath)

			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}

			const absolutePath = path.resolve(task.cwd, relPath)

			// Block writes outside workspace for safety (path traversal attack prevention)
			if (isPathOutsideWorkspace(absolutePath)) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(
					formatResponse.toolError(
						`Safety: cannot apply diff to path outside workspace: ${getReadablePath(task.cwd, relPath)}`,
					),
				)
				return
			}

			const fileExists = await fileExistsAtPath(absolutePath)

			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			const originalContent: string = await fs.readFile(absolutePath, "utf-8")

			// Apply the diff to the original content
			const diffResult = (await task.diffStrategy?.applyDiff(
				originalContent,
				diffContent,
				Number.isFinite(parseInt(params.diff.match(/:start_line:(\d+)/)?.[1] ?? "", 10))
				? parseInt(params.diff.match(/:start_line:(\d+)/)?.[1] ?? "", 10)
				: 1,
			)) ?? {
				success: false,
				error: "No diff strategy available",
			}

			if (!diffResult.success) {
				task.consecutiveMistakeCount++
				const currentCount = (task.consecutiveMistakeCountForApplyDiff.get(relPath) || 0) + 1
				task.consecutiveMistakeCountForApplyDiff.set(relPath, currentCount)
				let formattedError = ""
				TelemetryService.instance.captureDiffApplicationError(task.taskId, currentCount)

				if (diffResult.failParts && diffResult.failParts.length > 0) {
					for (const failPart of diffResult.failParts) {
						if (failPart.success) {
							continue
						}

						const errorDetails = failPart.details ? JSON.stringify(failPart.details, null, 2) : ""

						formattedError = `<error_details>\n${
							failPart.error
						}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
					}
				} else {
					const errorDetails = diffResult.details ? JSON.stringify(diffResult.details, null, 2) : ""

					formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${
						diffResult.error
					}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
				}

				if (currentCount >= 2) {
					await task.say("diff_error", formattedError)
				}

				task.recordToolError("apply_diff", formattedError)

				pushToolResult(formattedError)
				return
			}

			task.consecutiveMistakeCount = 0
			task.consecutiveMistakeCountForApplyDiff.delete(relPath)

			// Idempotency check: if the applied diff produces no changes,
			// the patch was likely already applied (retry / duplicate message).
			if (diffResult.content === originalContent) {
				task.consecutiveMistakeCountForApplyDiff.delete(relPath)
				pushToolResult(
					"No changes applied: the diff appears to have already been " +
					"applied to this file (result content matches original).",
				)
				await task.diffViewProvider.reset()
				this.resetPartialState()
				return
			}

			// Generate backend-unified diff for display in chat/webview
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, diffResult.content)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			const diffStats = computeDiffStats(unifiedPatch) || undefined

			// Check if preventFocusDisruption experiment is enabled
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			// Check if file is write-protected
			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

			const sharedMessageProps: ClineSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: diffContent,
			}

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy?.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.reset()
					return
				}

				// Save directly without showing diff view or opening the file
				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(
					relPath,
					diffResult.content,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				// Original behavior with diff view
				// Show diff view before asking for approval
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(diffResult.content, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy?.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					task.processQueuedMessages()
					return
				}

				// Call saveChanges to update the DiffViewProvider properties
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			// Used to determine if we should wait for busy terminal to update before sending api request
			task.didEditFile = true
			let partFailHint = ""

			if (diffResult.failParts && diffResult.failParts.length > 0) {
				partFailHint = `But unable to apply all diff parts to file: ${absolutePath}. Use the read_file tool to check the newest file version and re-apply diffs.\n`
			}

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			// Check for single SEARCH/REPLACE block warning
			const searchBlocks = (diffContent.match(/<<<<<<< SEARCH/g) || []).length
			const singleBlockNotice =
				searchBlocks === 1
					? "\n<notice>Making multiple related changes in a single apply_diff is more efficient. If other changes are needed in this file, please include them as additional SEARCH/REPLACE blocks.</notice>"
					: ""

			if (partFailHint) {
				pushToolResult(partFailHint + message + singleBlockNotice)
			} else {
				pushToolResult(message + singleBlockNotice)
			}

			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("applying diff", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_diff">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const diffContent: string | undefined = block.params.diff

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: diffContent,
		}

		let toolProgressStatus

		if (task.diffStrategy?.getProgressStatus) {
			toolProgressStatus = task.diffStrategy.getProgressStatus(block)
		}

		if (toolProgressStatus && Object.keys(toolProgressStatus).length === 0) {
			return
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial, toolProgressStatus).catch(ignoreAbortError)
	}
}

export const applyDiffTool = new ApplyDiffTool()
