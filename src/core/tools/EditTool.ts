import fs from "fs/promises"
import path from "path"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@njust-ai-cj/types"

import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath } from "../../utils/fs"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { sanitizeUnifiedDiff, computeDiffStats } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import {
	cangjiePreflightCheck,
	buildSearchGateWarning,
	CRITICAL_SIGNATURE_MODULES,
	resolveRootPackageName,
} from "./cangjiePreflightCheck"
import {
	countOccurrences,
	safeLiteralReplace,
	detectLineEnding,
	normalizeToLF,
	restoreLineEnding,
	buildWhitespaceTolerantRegex,
	buildTokenRegex,
	countRegexMatches,
	escapeRegExp,
	type LineEnding,
} from "./editMatching"

interface EditParams {
	file_path: string
	old_string: string
	new_string: string
	replace_all?: boolean
	expected_replacements?: number
}

export class EditTool extends BaseTool<"edit"> {
	readonly name = "edit" as const
	override readonly requiresCheckpoint = true

	override isConcurrencySafe(_params?: EditParams): boolean {
		return true
	}

	override get aliases(): readonly string[] {
		return ["search_and_replace", "edit_file", "search_replace"]
	}

	async execute(params: EditParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		// Coerce old_string/new_string to handle malformed native tool calls
		const file_path = params.file_path
		const old_string = typeof params.old_string === "string" ? params.old_string : ""
		const new_string = typeof params.new_string === "string" ? params.new_string : ""
		const replaceAll = params.replace_all ?? false
		const expectedReplacements = params.expected_replacements
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters
			if (!file_path) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "file_path"))
				return
			}

			// old_string must be provided (can be empty for file creation)
			if (old_string === undefined || old_string === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "old_string"))
				return
			}

			if (new_string === undefined || new_string === null) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(await task.sayAndCreateMissingParamError("edit", "new_string"))
				return
			}

			// Check old_string !== new_string (skip for file creation with empty old_string)
			if (old_string !== "" && old_string === new_string) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				pushToolResult(
					formatResponse.toolError(
						"'old_string' and 'new_string' are identical. No changes needed. If you want to make a change, ensure 'old_string' and 'new_string' are different.",
					),
				)
				return
			}

			// Resolve relative path (file_path can be absolute or relative)
			let relPath: string
			if (path.isAbsolute(file_path)) {
				relPath = path.relative(task.cwd, file_path)
			} else {
				relPath = file_path
			}

			const accessAllowed = allowRooIgnorePathAccess(task.rooIgnoreController, relPath)

			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}

			// Check if file is write-protected
			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

			const absolutePath = path.resolve(task.cwd, relPath)
			if (absolutePath.toLowerCase().endsWith(".cj") && task.taskMode === "cangjie") {
				const initError = await task.cangjieRuntimePolicy.ensureProjectInitializedForWrite(relPath)
				if (initError) {
					task.recordToolError("edit", initError)
					pushToolResult(formatResponse.toolError(initError))
					return
				}
			}

			const fileExists = await fileExistsAtPath(absolutePath)

			// File creation: empty old_string + non-existent file
			if (!fileExists && old_string === "") {
				// Cangjie preflight for new .cj files in cangjie mode
				if (absolutePath.toLowerCase().endsWith(".cj") && task.taskMode === "cangjie") {
					const rootPkg = await resolveRootPackageName(task.cwd)
					const preflight = cangjiePreflightCheck(new_string, relPath, task.cwd, rootPkg)
					if (!preflight.pass) {
						const errorMsg =
							`Cangjie preflight failed before creating file:\n` +
							preflight.errors.map((e) => `- ${e}`).join("\n")
						task.recordToolError("edit", errorMsg)
						pushToolResult(formatResponse.toolError(errorMsg))
						return
					}
				}

				task.consecutiveMistakeCount = 0

				// Initialize diff view for new file
				task.diffViewProvider.editType = "create"
				task.diffViewProvider.originalContent = ""

				const diff = formatResponse.createPrettyPatch(relPath, "", new_string)
				const sanitizedDiff = sanitizeUnifiedDiff(diff || "")
				const diffStats = computeDiffStats(sanitizedDiff) || undefined
				const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

				if (isOutsideWorkspace) {
					task.consecutiveMistakeCount++
					const formattedError = `Safety: cannot create file outside workspace: ${getReadablePath(task.cwd, relPath)}`
					task.recordToolError("edit", formattedError)
					pushToolResult(formattedError)
					return
				}

				const sharedMessageProps: ClineSayTool = {
					tool: "newFileCreated",
					path: getReadablePath(task.cwd, relPath),
					diff: sanitizedDiff,
					isOutsideWorkspace,
				}

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: sanitizedDiff,
					isProtected: isWriteProtected,
					diffStats,
				} satisfies ClineSayTool)

				const provider = task.providerRef.deref()
				const state = await provider?.getState()
				const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
				const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
				const isPreventFocusDisruptionEnabled = experiments.isEnabled(
					state?.experiments ?? {},
					EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
				)

				if (!isPreventFocusDisruptionEnabled) {
					await task.diffViewProvider.open(relPath)
					await task.diffViewProvider.update(new_string, true)
					task.diffViewProvider.scrollToFirstDiff()
				}

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					if (!isPreventFocusDisruptionEnabled) {
						await task.diffViewProvider.revertChanges()
					}
					pushToolResult("File creation was rejected by the user.")
					await task.diffViewProvider.reset()
					return
				}

				if (isPreventFocusDisruptionEnabled) {
					await task.diffViewProvider.saveDirectly(relPath, new_string, true, diagnosticsEnabled, writeDelayMs)
				} else {
					await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
				}

				if (relPath) {
					await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
				}

				task.didEditFile = true
				task.cangjieRuntimePolicy.noteWriteApplied(relPath, undefined, new_string)
				const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, true)
				pushToolResult(message)

				task.recordToolUsage("edit")
				await task.diffViewProvider.reset()
				this.resetPartialState()
				task.processQueuedMessages()
				return
			}

			// File must exist for non-creation edits
			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				const errorMessage = `File not found: ${relPath}. To create a new file, set old_string to an empty string "".`
				await task.say("error", errorMessage)
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			// File exists but old_string is empty → file already exists
			if (old_string === "") {
				task.consecutiveMistakeCount++
				const formattedError = `File already exists: ${absolutePath}\n\n<error_details>\nYou provided an empty old_string, which indicates file creation, but the target file already exists.\n\nRecovery suggestions:\n1. To modify an existing file, provide a non-empty old_string that matches the current file contents\n2. Use read_file to confirm the exact text to match\n3. If you intended to overwrite the entire file, use write_to_file instead\n</error_details>`
				task.recordToolError("edit", formattedError)
				pushToolResult(formattedError)
				return
			}

			let currentContent: string
			let currentContentLF: string
			let originalEol: LineEnding = "\n"
			try {
				currentContent = await fs.readFile(absolutePath, "utf8")
				originalEol = detectLineEnding(currentContent)
				currentContentLF = normalizeToLF(currentContent)
			} catch (error) {
				task.consecutiveMistakeCount++
				task.recordToolError("edit")
				const errorDetails = error instanceof Error ? error.message : String(error)
				const formattedError = `Failed to read file: ${absolutePath}\n\n<error_details>\nRead error: ${errorDetails}\n\nRecovery suggestions:\n1. Verify the file exists and is readable\n2. Check file permissions\n3. If the file may have changed, use read_file to confirm its current contents\n</error_details>`
				pushToolResult(formattedError)
				return
			}

			const oldLF = normalizeToLF(old_string)
			const newLF = normalizeToLF(new_string)
			const expectedCount = expectedReplacements ?? (replaceAll ? null : 1)

			// Multi-strategy matching (from EditFileTool):
			// Strategy 1: exact literal match → Strategy 2: whitespace-tolerant → Strategy 3: token-based
			const cangjieFile = absolutePath.toLowerCase().endsWith(".cj")
			const wsRegex = buildWhitespaceTolerantRegex(oldLF, { cangjie: cangjieFile })
			const tokenRegex = cangjieFile ? new RegExp("(?!)", "g") : buildTokenRegex(oldLF)

			let newContentLF: string
			let matchStrategy: string | undefined

			// Strategy 1: exact literal match
			const exactOccurrences = countOccurrences(currentContentLF, oldLF)
			if (expectedCount === null ? exactOccurrences > 0 : exactOccurrences === expectedCount) {
				if (expectedCount === null) {
					// replace_all: replace all occurrences
					newContentLF = safeLiteralReplace(currentContentLF, oldLF, newLF)
				} else {
					newContentLF = safeLiteralReplace(currentContentLF, oldLF, newLF)
				}
			} else {
				// Strategy 2: whitespace-tolerant regex
				const wsOccurrences = countRegexMatches(currentContentLF, wsRegex)
				if (expectedCount === null ? wsOccurrences > 0 : wsOccurrences === expectedCount) {
					newContentLF = currentContentLF.replace(wsRegex, () => newLF)
					matchStrategy = "whitespace-tolerant"
				} else {
					// Strategy 3: token-based regex
					const tokenOccurrences = countRegexMatches(currentContentLF, tokenRegex)
					if (expectedCount === null ? tokenOccurrences > 0 : tokenOccurrences === expectedCount) {
						newContentLF = currentContentLF.replace(tokenRegex, () => newLF)
						matchStrategy = "token-based"
					} else {
						// All strategies failed — report error
						const anyMatches = exactOccurrences > 0 || wsOccurrences > 0 || tokenOccurrences > 0
						if (!anyMatches) {
							task.consecutiveMistakeCount++
							task.recordToolError("edit", "no_match")
							pushToolResult(
								formatResponse.toolError(
									`No match found for 'old_string' in ${relPath}. Make sure the text to find appears exactly in the file, including whitespace and indentation.`,
								),
							)
							return
						}

						if (exactOccurrences > 0) {
							task.consecutiveMistakeCount++
							const formattedError =
								expectedCount === null
									? formatResponse.toolError(
											`Found ${exactOccurrences} exact match(es). replace_all will replace all of them.`,
										)
									: formatResponse.toolError(
											`Expected ${expectedCount} occurrence(s) but found ${exactOccurrences} exact match(es). Use replace_all: true to replace all, adjust expected_replacements to ${exactOccurrences}, or provide more context in old_string to make it unique.`,
										)
							task.recordToolError("edit", formattedError)
							pushToolResult(formattedError)
							return
						}

						task.consecutiveMistakeCount++
						const formattedError = formatResponse.toolError(
							`Occurrence count mismatch in file: ${absolutePath}\n\n<error_details>\nExpected ${expectedCount} occurrence(s), but matching found ${wsOccurrences} (whitespace-tolerant) and ${tokenOccurrences} (token-based).\n\nRecovery suggestions:\n1. Provide more surrounding context in old_string to make the match unique\n2. Use read_file to confirm the current file contents and refine the match\n</error_details>`,
						)
						task.recordToolError("edit", formattedError)
						pushToolResult(formattedError)
						return
					}
				}
			}

			const newContent = restoreLineEnding(newContentLF, originalEol)

			if (newContent === currentContent) {
				pushToolResult(`No changes needed for '${relPath}'`)
				return
			}

			task.consecutiveMistakeCount = 0

			// Cangjie preflight check for .cj files (only in Cangjie mode)
			let cangjiePostWriteWarnings = ""
			if (absolutePath.toLowerCase().endsWith(".cj") && task.taskMode === "cangjie") {
				const structureError = await task.cangjieRuntimePolicy.validateProjectStructureForWrite(relPath, newContent)
				if (structureError) {
					task.recordToolError("edit", structureError)
					pushToolResult(formatResponse.toolError(structureError))
					return
				}
				const rootPkg = await resolveRootPackageName(task.cwd)
				const preflight = cangjiePreflightCheck(newContent, relPath, task.cwd, rootPkg)
				if (!preflight.pass) {
					const errorMsg =
						`Cangjie preflight failed before applying edit:\n` +
						preflight.errors.map((e) => `- ${e}`).join("\n")
					task.recordToolError("edit", errorMsg)
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
				if (preflight.warnings.length > 0) {
					cangjiePostWriteWarnings =
						`\n\n<cangjie_preflight_warnings>\n` +
						preflight.warnings.map((w) => `- ${w}`).join("\n") +
						`\n</cangjie_preflight_warnings>`
				}
				const missingEvidence = task.cangjieRuntimePolicy.getMissingImportEvidence(currentContent, newContent)
				if (missingEvidence.length > 0) {
					const errorMsg =
						`Missing bundled corpus evidence for newly introduced stdlib modules: ${missingEvidence.join(", ")}. ` +
						`Use search_files or read_file against the bundled CangjieCorpus before editing this code.`
					task.recordToolError("edit", errorMsg)
					pushToolResult(formatResponse.toolError(errorMsg))
					return
				}
				const searchGate = buildSearchGateWarning(
					newContent,
					task.cangjieSearchHistory ?? new Set(),
					CRITICAL_SIGNATURE_MODULES,
				)
				if (searchGate) {
					cangjiePostWriteWarnings += searchGate
				}
			}

			// Initialize diff view
			task.diffViewProvider.editType = "modify"
			task.diffViewProvider.originalContent = currentContent

			// Generate and validate diff
			const diff = formatResponse.createPrettyPatch(relPath, currentContent, newContent)
			if (!diff) {
				pushToolResult(`No changes needed for '${relPath}'`)
				await task.diffViewProvider.reset()
				return
			}

			// Check if preventFocusDisruption experiment is enabled
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			const sanitizedDiff = sanitizeUnifiedDiff(diff)
			const diffStats = computeDiffStats(sanitizedDiff) || undefined
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			if (isOutsideWorkspace) {
				task.consecutiveMistakeCount++
				const formattedError = `Safety: cannot edit file outside workspace: ${getReadablePath(task.cwd, relPath)}`
				task.recordToolError("edit", formattedError)
				pushToolResult(formattedError)
				return
			}

			const sharedMessageProps: ClineSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: sanitizedDiff,
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: sanitizedDiff,
				isProtected: isWriteProtected,
				diffStats,
			} satisfies ClineSayTool)

			// Show diff view if focus disruption prevention is disabled
			if (!isPreventFocusDisruptionEnabled) {
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(newContent, true)
				task.diffViewProvider.scrollToFirstDiff()
			}

			const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

			if (!didApprove) {
				// Revert changes if diff view was shown
				if (!isPreventFocusDisruptionEnabled) {
					await task.diffViewProvider.revertChanges()
				}
				pushToolResult("Changes were rejected by the user.")
				await task.diffViewProvider.reset()
				return
			}

			// Save the changes
			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view or opening the file
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				// Call saveChanges to update the DiffViewProvider properties
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true
			task.cangjieRuntimePolicy.noteWriteApplied(relPath, currentContent, newContent)

			// Get the formatted response message
			const matchStrategyNote = matchStrategy ? ` (matched via ${matchStrategy} strategy)` : ""
			const replacementNote = expectedReplacements && expectedReplacements > 1 ? ` (${expectedReplacements} replacements)` : ""
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)
			pushToolResult(message + matchStrategyNote + replacementNote + cangjiePostWriteWarnings)

			// Record successful tool usage and cleanup
			task.recordToolUsage("edit")
			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()
		} catch (error) {
			await handleError("edit", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"edit">): Promise<void> {
		const relPath: string | undefined = block.params.file_path

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		// relPath is guaranteed non-null after hasPathStabilized
		const absolutePath = path.resolve(task.cwd, relPath!)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath!),
			diff: block.params.old_string ? "1 edit operation" : undefined,
			isOutsideWorkspace,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(ignoreAbortError)
	}
}

export const editTool = new EditTool()
export const searchAndReplaceTool = editTool // alias for backward compat
