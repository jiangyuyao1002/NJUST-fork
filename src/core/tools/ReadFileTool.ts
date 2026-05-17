/**
 * ReadFileTool - Codex-inspired file reading with indentation mode support.
 *
 * Supports two modes:
 * 1. Slice mode (default): Read contiguous lines with offset/limit
 * 2. Indentation mode: Extract semantic code blocks based on indentation hierarchy
 *
 * Also supports legacy format for backward compatibility:
 * - Legacy format: { files: [{ path: string, lineRanges?: [...] }] }
 */
import path from "path"
import * as fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"

import type { ReadFileParams, ReadFileMode, ReadFileToolParams, FileEntry, LineRange } from "@njust-ai-cj/types"
import { isLegacyReadFileParams, type ClineSayTool } from "@njust-ai-cj/types"

import { allowRooIgnorePathAccess } from "../ignore/RooIgnoreController"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathUnderBundledCangjieCorpus, isPathPotentiallyUnderCangjieCorpus } from "../../utils/bundledCangjieCorpus"
import { getReadablePath } from "../../utils/path"
import { extractTextFromFile, addLineNumbers, getSupportedBinaryFormats } from "../../integrations/misc/extract-text"
import { readWithIndentation, readWithSlice } from "../../integrations/misc/indentation-reader"
import { DEFAULT_LINE_LIMIT } from "../prompts/tools/native-tools/read_file"
import type { ToolUse, PushToolResult } from "../../shared/tools"

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	isSupportedImageFormat,
	validateImageForProcessing,
	processImageFile,
	ImageMemoryTracker,
} from "./helpers/imageHelpers"
import { fileReadCache } from "./helpers/FileReadCache"
import { toolResultCache } from "./helpers/ToolResultCache"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Device files and special paths that should never be read.
 * Reading these can cause infinite loops, hangs, or other dangerous behavior.
 * Inspired by Claude Code's FileReadTool BLOCKED_DEVICE_PATHS.
 */
const BLOCKED_DEVICE_PATHS = new Set([
	"/dev/zero",
	"/dev/random",
	"/dev/urandom",
	"/dev/null",
	"/dev/stdin",
	"/dev/stdout",
	"/dev/stderr",
])

/**
 * Windows special device names (case-insensitive).
 * These can appear as bare names or with extensions (e.g., CON.txt).
 */
const BLOCKED_WINDOWS_DEVICES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
])

/**
 * Checks if a file path refers to a blocked device or special file.
 */
function isBlockedDevicePath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase()

	// Check Unix device paths
	if (BLOCKED_DEVICE_PATHS.has(normalized)) return true

	// Check Windows device names (can appear as bare name or with extensions)
	const basename = path.basename(filePath).toLowerCase().split(".")[0]!
	if (BLOCKED_WINDOWS_DEVICES.has(basename)) return true

	return false
}

/**
 * Internal entry structure for tracking file read parameters.
 */
interface InternalFileEntry {
	path: string
	mode?: ReadFileMode
	offset?: number
	limit?: number
	anchor_line?: number
	max_levels?: number
	include_siblings?: boolean
	include_header?: boolean
	max_lines?: number
}

interface FileResult {
	path: string
	status: "approved" | "denied" | "blocked" | "error" | "pending"
	content?: string
	error?: string
	notice?: string
	nativeContent?: string
	imageDataUrl?: string
	feedbackText?: string
	feedbackImages?: string[]
	// Store the original entry for mode processing
	entry?: InternalFileEntry
}

// ─── Tool Implementation ──────────────────────────────────────────────────────

export class ReadFileTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	override isConcurrencySafe(): boolean {
		return true
	}

	override isReadOnly(): boolean {
		return true
	}

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Record<string, UnsafeAny>): boolean {
		return typeof partial.path === "string" && (partial.path as string).length > 0
	}

	override userFacingName(): string {
		return "Read File"
	}

	async execute(params: ReadFileToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		// Dispatch to legacy or new execution path based on format
		if (isLegacyReadFileParams(params)) {
			return this.executeLegacy(params.files, task, callbacks)
		}

		return this.executeNew(params, task, callbacks)
	}

	/**
	 * Execute new single-file format with slice/indentation mode support.
	 */
	private async executeNew(params: ReadFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const modelInfo = task.api.getModel().info
		const resultCacheKey = toolResultCache.makeKey("read_file", params)
		const cached = toolResultCache.get(resultCacheKey)
		if (cached) {
			pushToolResult(cached)
			return
		}
		const filePath = typeof params.path === "string" ? params.path.trim() : ""

		// Validate input (models sometimes omit path or send "" / whitespace despite JSON schema)
		if (!filePath) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			const errorMsg = await task.sayAndCreateMissingParamError("read_file", "path")
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		// Block device files and special paths that could cause hangs or infinite reads
		if (isBlockedDevicePath(filePath)) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			pushToolResult(`Error: Reading device or special file "${filePath}" is blocked for safety. These files can cause infinite reads or system hangs.`)
			return
		}

		const supportsImages = modelInfo.supportsImages ?? false

		// Initialize file results tracking
		// Validate line number parameters (must be 1-indexed positive integers)
		if (params.offset !== undefined && params.offset < 1) {
			const errorMsg = `offset must be a 1-indexed line number (got ${params.offset}). Line numbers start at 1.`
			pushToolResult(`Error: ${errorMsg}`)
			return
		}
		if (params.indentation?.anchor_line !== undefined && params.indentation.anchor_line < 1) {
			const errorMsg = `anchor_line must be a 1-indexed line number (got ${params.indentation.anchor_line}). Line numbers start at 1.`
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		const fileEntry: InternalFileEntry = {
			path: filePath,
			mode: params.mode,
			offset: params.offset,
			limit: params.limit,
			anchor_line: params.indentation?.anchor_line,
			max_levels: params.indentation?.max_levels,
			include_siblings: params.indentation?.include_siblings,
			include_header: params.indentation?.include_header,
			max_lines: params.indentation?.max_lines,
		}

		const fileResults: FileResult[] = [
			{
				path: filePath,
				status: "pending" as const,
				entry: fileEntry,
			},
		]

		const updateFileResult = (filePath: string, updates: Partial<FileResult>) => {
			const index = fileResults.findIndex((result) => result.path === filePath)
			if (index !== -1) {
				fileResults[index] = { ...fileResults[index]!, ...updates }
			}
		}

		try {
			// Phase 1: Validate and filter files for approval
			const filesToApprove: FileResult[] = []

			for (const fileResult of fileResults) {
				const relPath = fileResult.path

				// RooIgnore validation
				const accessAllowed = allowRooIgnorePathAccess(task.rooIgnoreController, relPath)
				if (!accessAllowed) {
					await task.say("rooignore_error", relPath)
					const errorMsg = formatResponse.rooIgnoreError(relPath)
					updateFileResult(relPath, {
						status: "blocked",
						error: errorMsg,
						nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
					})
					continue
				}

				filesToApprove.push(fileResult)
			}

			// Phase 2: Request user approval
			await this.requestApproval(task, filesToApprove, updateFileResult)

			// Phase 3: Process approved files
			const imageMemoryTracker = new ImageMemoryTracker()
			const state = await task.providerRef.deref()?.getState()
			const {
				maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
				maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
			} = state ?? {}

			for (const fileResult of fileResults) {
				if (fileResult.status !== "approved") continue

				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)
				const entry = fileResult.entry!

				try {
					// Check if path is a directory
					const stats = await fs.stat(fullPath)
					if (stats.isDirectory()) {
						const errorMsg = `Cannot read '${relPath}' because it is a directory. Use list_files tool instead.`
						updateFileResult(relPath, {
							status: "error",
							error: errorMsg,
							nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
						})
						await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
						continue
					}

					// Check for binary file
					const isBinary = await isBinaryFile(fullPath)

					if (isBinary) {
						await this.handleBinaryFile(
							task,
							relPath,
							fullPath,
							supportsImages,
							maxImageFileSize,
							maxTotalImageSize,
							imageMemoryTracker,
							updateFileResult,
						)
						continue
					}

					// Read text file content via mtime-aware LRU cache
					const fileContent = await fileReadCache.getTextFile(fullPath, stats.mtimeMs, stats.size)
					const result = this.processTextFile(fileContent, entry)

					await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

					updateFileResult(relPath, {
						nativeContent: `File: ${relPath}\n${result}`,
					})
				} catch (error) {
					const errorMsg = getErrorMessage(error)
					updateFileResult(relPath, {
						status: "error",
						error: `Error reading file: ${errorMsg}`,
						nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
					})
					await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
				}
			}

			// Phase 4: Build and return result
			const hasErrors = fileResults.some((r) => r.status === "error" || r.status === "blocked")
			if (hasErrors) {
				task.didToolFailInCurrentTurn = true
			}

			this.buildAndPushResult(task, fileResults, pushToolResult, resultCacheKey)
		} catch (error) {
			const relPath = filePath || "UnsafeAny"
			const errorMsg = getErrorMessage(error)

			updateFileResult(relPath, {
				status: "error",
				error: `Error reading file: ${errorMsg}`,
				nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
			})

			await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
			task.didToolFailInCurrentTurn = true

			const errorResult = fileResults
				.filter((r) => r.nativeContent)
				.map((r) => r.nativeContent)
				.join("\n\n---\n\n")

			pushToolResult(errorResult || `Error: ${errorMsg}`)
		}
	}

	/**
	 * Slice mode: read the full requested range in one tool invocation (single user approval).
	 * Previously only the first `limit` lines were returned and the model had to call read_file
	 * again, which triggered approval each time.
	 */
	private readFullFileInSliceMode(content: string, entry: InternalFileEntry): string {
		if (content === "") {
			return "Note: File is empty"
		}

		const offset1 = entry.offset ?? 1
		let offset0 = Math.max(0, offset1 - 1)
		const limit = entry.limit ?? DEFAULT_LINE_LIMIT
		/** Safety cap: at most 500 chunks × limit lines (e.g. 1M lines at default limit). */
		const MAX_SLICES = 500
		const segments: string[] = []

		for (let i = 0; i < MAX_SLICES; i++) {
			const result = readWithSlice(content, offset0, limit)

			if (result.content.startsWith("Error:")) {
				return result.content
			}

			segments.push(result.content)

			if (!result.wasTruncated) {
				if (segments.length === 1) {
					return segments[0]!
				}
				return segments.join("\n\n")
			}

			offset0 += result.returnedLines
		}

		return `${segments.join("\n\n")}\n\nIMPORTANT: File still truncated after reading ${MAX_SLICES * limit} lines. Use read_file with offset=${offset0 + 1} and limit=${limit} to continue.`
	}

	/**
	 * Process a text file according to the requested mode.
	 */
	private processTextFile(content: string, entry: InternalFileEntry): string {
		const mode = entry.mode || "slice"

		if (mode === "indentation") {
			// Indentation mode: semantic block extraction
			// When anchor_line is not provided, default to offset (which defaults to 1)
			const anchorLine = entry.anchor_line ?? entry.offset ?? 1
			const result = readWithIndentation(content, {
				anchorLine,
				maxLevels: entry.max_levels,
				includeSiblings: entry.include_siblings,
				includeHeader: entry.include_header,
				limit: entry.limit ?? DEFAULT_LINE_LIMIT,
				maxLines: entry.max_lines,
			})

			let output = result.content

			if (result.wasTruncated && result.includedRanges.length > 0) {
				const [start, end] = result.includedRanges[0]!
				const nextOffset = end + 1
				const effectiveLimit = entry.limit ?? DEFAULT_LINE_LIMIT
				// Put truncation warning at TOP (before content) to match @ mention format
				output = `IMPORTANT: File content truncated.
	Status: Showing lines ${start}-${end} of ${result.totalLines} total lines.
	To read more: Use the read_file tool with offset=${nextOffset} and limit=${effectiveLimit}.
	
	${result.content}`
			} else if (result.includedRanges.length > 0) {
				const rangeStr = result.includedRanges.map(([s, e]) => `${s}-${e}`).join(", ")
				output += `\n\nIncluded ranges: ${rangeStr} (total: ${result.totalLines} lines)`
			}

			return output
		}

		// Slice mode (default): read through end of file in one approval (chunked internally).
		return this.readFullFileInSliceMode(content, entry)
	}

	/**
	 * Handle binary file processing (images, PDF, DOCX, etc.).
	 */
	private async handleBinaryFile(
		task: Task,
		relPath: string,
		fullPath: string,
		supportsImages: boolean,
		maxImageFileSize: number,
		maxTotalImageSize: number,
		imageMemoryTracker: ImageMemoryTracker,
		updateFileResult: (path: string, updates: Partial<FileResult>) => void,
	): Promise<void> {
		const fileExtension = path.extname(relPath).toLowerCase()
		const supportedBinaryFormats = getSupportedBinaryFormats()

		// Handle image files
		if (isSupportedImageFormat(fileExtension)) {
			try {
				const validationResult = await validateImageForProcessing(
					fullPath,
					supportsImages,
					maxImageFileSize,
					maxTotalImageSize,
					imageMemoryTracker.getTotalMemoryUsed(),
				)

				if (!validationResult.isValid) {
					await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)
					updateFileResult(relPath, {
						nativeContent: `File: ${relPath}\nNote: ${validationResult.notice}`,
					})
					return
				}

				const imageResult = await processImageFile(fullPath)
				imageMemoryTracker.addMemoryUsage(imageResult.sizeInMB)
				await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(relPath, {
					nativeContent: `File: ${relPath}\nNote: ${imageResult.notice}`,
					imageDataUrl: imageResult.dataUrl,
				})
				return
			} catch (error) {
				const errorMsg = getErrorMessage(error)
				updateFileResult(relPath, {
					status: "error",
					error: `Error reading image file: ${errorMsg}`,
					nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
				})
				await task.say("error", `Error reading image file ${relPath}: ${errorMsg}`)
				return
			}
		}

		// Handle other supported binary formats (PDF, DOCX, etc.)
		if (supportedBinaryFormats?.includes(fileExtension)) {
			try {
				const content = await extractTextFromFile(fullPath)
				const numberedContent = addLineNumbers(content)
				const lineCount = content.split("\n").length

				await task.fileContextTracker.trackFileContext(relPath, "read_tool" as RecordSource)

				updateFileResult(relPath, {
					nativeContent:
						lineCount > 0
							? `File: ${relPath}\nLines 1-${lineCount}:\n${numberedContent}`
							: `File: ${relPath}\nNote: File is empty`,
				})
				return
			} catch (error) {
				const errorMsg = getErrorMessage(error)
				updateFileResult(relPath, {
					status: "error",
					error: `Error extracting text: ${errorMsg}`,
					nativeContent: `File: ${relPath}\nError: ${errorMsg}`,
				})
				await task.say("error", `Error extracting text from ${relPath}: ${errorMsg}`)
				return
			}
		}

		// Unsupported binary format
		const fileFormat = fileExtension.slice(1) || "bin"
		updateFileResult(relPath, {
			notice: `Binary file format: ${fileFormat}`,
			nativeContent: `File: ${relPath}\nBinary file (${fileFormat}) - content not displayed`,
		})
	}

	/**
	 * Request user approval for file reads.
	 */
	private async requestApproval(
		task: Task,
		filesToApprove: FileResult[],
		updateFileResult: (path: string, updates: Partial<FileResult>) => void,
	): Promise<void> {
		if (filesToApprove.length === 0) return

		const extensionPath = task.providerRef.deref()?.context.extensionPath

		// Auto-approve bundled CangjieCorpus files silently
		const remaining: FileResult[] = []
		for (const fr of filesToApprove) {
			const fullPath = path.resolve(task.cwd, fr.path)
			if (isPathUnderBundledCangjieCorpus(fullPath, extensionPath)) {
				if (task.taskMode === "cangjie") {
					task.cangjieRuntimePolicy.noteCorpusReadPath(fullPath)
				}
				updateFileResult(fr.path, { status: "approved" })
			} else {
				remaining.push(fr)
			}
		}

		if (remaining.length === 0) return

		if (remaining.length > 1) {
			// Batch approval
			const batchFiles = remaining.map((fileResult) => {
				const relPath = fileResult.path
				const fullPath = path.resolve(task.cwd, relPath)
				const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
				const readablePath = getReadablePath(task.cwd, relPath)

				const lineSnippet = this.getLineSnippet(fileResult.entry!)
				const key = `${readablePath}${lineSnippet ? ` (${lineSnippet})` : ""}`

				return { path: readablePath, lineSnippet, isOutsideWorkspace, key, content: fullPath }
			})

			const completeMessage = JSON.stringify({ tool: "readFile", batchFiles } satisfies ClineSayTool)
			const { response, text, images } = await task.ask("tool", completeMessage, false)

			if (response === "yesButtonClicked") {
				if (text) await task.say("user_feedback", text, images)
				remaining.forEach((fr) => {
					updateFileResult(fr.path, { status: "approved", feedbackText: text, feedbackImages: images })
				})
			} else if (response === "noButtonClicked") {
				if (text) await task.say("user_feedback", text, images)
				task.didRejectTool = true
				remaining.forEach((fr) => {
					updateFileResult(fr.path, {
						status: "denied",
						nativeContent: `File: ${fr.path}\nStatus: Denied by user`,
						feedbackText: text,
						feedbackImages: images,
					})
				})
			} else {
				// Individual permissions
				try {
					const individualPermissions = JSON.parse(text || "{}")
					let hasAnyDenial = false

					batchFiles.forEach((batchFile, index) => {
						const fileResult = remaining[index]!
						const approved = individualPermissions[batchFile.key] === true

						if (approved) {
							updateFileResult(fileResult.path, { status: "approved" })
						} else {
							hasAnyDenial = true
							updateFileResult(fileResult.path, {
								status: "denied",
								nativeContent: `File: ${fileResult.path}\nStatus: Denied by user`,
							})
						}
					})

					if (hasAnyDenial) task.didRejectTool = true
				} catch {
					task.didRejectTool = true
					remaining.forEach((fr) => {
						updateFileResult(fr.path, {
							status: "denied",
							nativeContent: `File: ${fr.path}\nStatus: Denied by user`,
						})
					})
				}
			}
		} else {
			// Single file approval
			const fileResult = remaining[0]!
			const relPath = fileResult.path
			const fullPath = path.resolve(task.cwd, relPath)

			const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
			const lineSnippet = this.getLineSnippet(fileResult.entry!)

			const startLine = this.getStartLine(fileResult.entry!)

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getReadablePath(task.cwd, relPath),
				isOutsideWorkspace,
				content: fullPath,
				reason: lineSnippet,
				startLine,
			} satisfies ClineSayTool)

			const { response, text, images } = await task.ask("tool", completeMessage, false)

			if (response !== "yesButtonClicked") {
				if (text) await task.say("user_feedback", text, images)
				task.didRejectTool = true
				updateFileResult(relPath, {
					status: "denied",
					nativeContent: `File: ${relPath}\nStatus: Denied by user`,
					feedbackText: text,
					feedbackImages: images,
				})
			} else {
				if (text) await task.say("user_feedback", text, images)
				updateFileResult(relPath, { status: "approved", feedbackText: text, feedbackImages: images })
			}
		}
	}

	/**
	 * Get the starting line number for navigation purposes.
	 */
	private getStartLine(entry: InternalFileEntry): number | undefined {
		if (entry.mode === "indentation") {
			// For indentation mode, always return the effective anchor line
			return entry.anchor_line ?? entry.offset ?? 1
		}
		const offset = entry.offset ?? 1
		return offset > 1 ? offset : undefined
	}

	/**
	 * Generate a human-readable line snippet for approval messages.
	 */
	private getLineSnippet(entry: InternalFileEntry): string {
		if (entry.mode === "indentation") {
			// Always show indentation mode with the effective anchor line
			const effectiveAnchor = entry.anchor_line ?? entry.offset ?? 1
			return `(indentation mode at line ${effectiveAnchor})`
		}

		const limit = entry.limit ?? DEFAULT_LINE_LIMIT
		const offset1 = entry.offset ?? 1

		if (offset1 > 1) {
			return `(lines ${offset1}-${offset1 + limit - 1})`
		}

		// Always show the line limit, even when using the default
		return `(up to ${limit} lines)`
	}

	/**
	 * Build and push the final result to the tool output.
	 */
	private buildAndPushResult(task: Task, fileResults: FileResult[], pushToolResult: PushToolResult, cacheKey?: string): void {
		const finalResult = fileResults
			.filter((r) => r.nativeContent)
			.map((r) => r.nativeContent)
			.join("\n\n---\n\n")

		const fileImageUrls = fileResults.filter((r) => r.imageDataUrl).map((r) => r.imageDataUrl as string)

		let statusMessage = ""
		let feedbackImages: string[] = []

		const deniedWithFeedback = fileResults.find((r) => r.status === "denied" && r.feedbackText)

		if (deniedWithFeedback?.feedbackText) {
			statusMessage = formatResponse.toolDeniedWithFeedback(deniedWithFeedback.feedbackText)
			feedbackImages = deniedWithFeedback.feedbackImages || []
		} else if (task.didRejectTool) {
			statusMessage = formatResponse.toolDenied()
		} else {
			const approvedWithFeedback = fileResults.find((r) => r.status === "approved" && r.feedbackText)
			if (approvedWithFeedback?.feedbackText) {
				statusMessage = formatResponse.toolApprovedWithFeedback(approvedWithFeedback.feedbackText)
				feedbackImages = approvedWithFeedback.feedbackImages || []
			}
		}

		const allImages = [...feedbackImages, ...fileImageUrls]
		const finalModelSupportsImages = task.api.getModel().info.supportsImages ?? false
		const imagesToInclude = finalModelSupportsImages ? allImages : []

		if (statusMessage || imagesToInclude.length > 0) {
			const result = formatResponse.toolResult(
				statusMessage || finalResult,
				imagesToInclude.length > 0 ? imagesToInclude : undefined,
			)

			if (typeof result === "string") {
				const out = statusMessage ? `${result}\n${finalResult}` : result
				if (cacheKey) toolResultCache.set(cacheKey, out)
				pushToolResult(out)
			} else {
				if (statusMessage) {
					const textBlock = { type: "text" as const, text: finalResult }
					pushToolResult([...result, textBlock] as UnsafeAny)
				} else {
					pushToolResult(result as UnsafeAny)
				}
			}
		} else {
			if (cacheKey) toolResultCache.set(cacheKey, finalResult)
			pushToolResult(finalResult)
		}
	}

	getReadFileToolDescription(blockName: string, blockParams: { path?: string }): string
	getReadFileToolDescription(blockName: string, nativeArgs: ReadFileParams): string
	getReadFileToolDescription(blockName: string, second: UnsafeAny): string {
		// If native typed args were provided
		if (second && typeof second === "object" && "path" in second && typeof (second as Record<string, UnsafeAny>).path === "string") {
			return `[${blockName} for '${(second as Record<string, UnsafeAny>).path}']`
		}

		const blockParams = second as Record<string, UnsafeAny>
		if (blockParams?.path) {
			return `[${blockName} for '${blockParams.path}']`
		}
		return `[${blockName} with missing path]`
	}

	override async handlePartial(task: Task, block: ToolUse<"read_file">): Promise<void> {
		// Handle both legacy and new format for partial display
		let filePath = ""
		if (block.nativeArgs) {
			if (isLegacyReadFileParams(block.nativeArgs)) {
				// Legacy format - show first file
				filePath = block.nativeArgs.files[0]?.path ?? ""
			} else {
				filePath = block.nativeArgs.path ?? ""
			}
		}

		const fullPath = filePath ? path.resolve(task.cwd, filePath) : ""
		const extensionPath = task.providerRef.deref()?.context.extensionPath

		if (filePath && isPathPotentiallyUnderCangjieCorpus(fullPath, extensionPath, filePath)) {
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "readFile",
			path: getReadablePath(task.cwd, filePath),
			isOutsideWorkspace: filePath ? isPathOutsideWorkspace(fullPath) : false,
		}
		const partialMessage = JSON.stringify({
			...sharedMessageProps,
			content: undefined,
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}

	/**
	 * Execute legacy multi-file format for backward compatibility.
	 * This handles the old format: { files: [{ path: string, lineRanges?: [...] }] }
	 */
	private async executeLegacy(fileEntries: FileEntry[], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const modelInfo = task.api.getModel().info

		// Temporary indicator for testing legacy format detection
		logger.warn("ReadFileTool", "Legacy format detected - using backward compatibility path")

		if (!fileEntries || fileEntries.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_file")
			const errorMsg = await task.sayAndCreateMissingParamError("read_file", "files")
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		const supportsImages = modelInfo.supportsImages ?? false

		// Process each file sequentially (legacy behavior)
		const results: string[] = []

		for (const entry of fileEntries) {
			const relPath = entry.path
			const fullPath = path.resolve(task.cwd, relPath)

			// RooIgnore validation
			const accessAllowed = allowRooIgnorePathAccess(task.rooIgnoreController, relPath)
			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				const errorMsg = formatResponse.rooIgnoreError(relPath)
				results.push(`File: ${relPath}\nError: ${errorMsg}`)
				continue
			}

			// Request approval for single file
			const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
			let lineSnippet = ""
			if (entry.lineRanges && entry.lineRanges.length > 0) {
				const ranges = entry.lineRanges.map((range: LineRange) => `(lines ${range.start}-${range.end})`)
				lineSnippet = ranges.join(", ")
			}

			const completeMessage = JSON.stringify({
				tool: "readFile",
				path: getReadablePath(task.cwd, relPath),
				isOutsideWorkspace,
				content: fullPath,
				reason: lineSnippet || undefined,
			} satisfies ClineSayTool)

			const { response, text, images } = await task.ask("tool", completeMessage, false)

			if (response !== "yesButtonClicked") {
				if (text) await task.say("user_feedback", text, images)
				task.didRejectTool = true
				results.push(`File: ${relPath}\nStatus: Denied by user`)
				continue
			}

			if (text) await task.say("user_feedback", text, images)

			try {
				// Check if the path is a directory
				const stats = await fs.stat(fullPath)
				if (stats.isDirectory()) {
					const errorMsg = `Cannot read '${relPath}' because it is a directory.`
					results.push(`File: ${relPath}\nError: ${errorMsg}`)
					await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
					continue
				}

				const isBinary = await isBinaryFile(fullPath).catch(() => false)

				if (isBinary) {
					// Handle binary files (images)
					const fileExtension = path.extname(relPath).toLowerCase()
					if (supportsImages && isSupportedImageFormat(fileExtension)) {
						const state = await task.providerRef.deref()?.getState()
						const {
							maxImageFileSize = DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
							maxTotalImageSize = DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
						} = state ?? {}
						const validation = await validateImageForProcessing(
							fullPath,
							supportsImages,
							maxImageFileSize,
							maxTotalImageSize,
							0, // Legacy path doesn't track cumulative memory
						)
						if (!validation.isValid) {
							results.push(`File: ${relPath}\nNotice: ${validation.notice ?? "Image validation failed"}`)
							continue
						}
						const imageResult = await processImageFile(fullPath)
						if (imageResult) {
							results.push(`File: ${relPath}\n[Image file - content processed for vision model]`)
						}
					} else {
						results.push(`File: ${relPath}\nError: Cannot read binary file`)
					}
					continue
				}

				// Read text file
				const rawContent = await fs.readFile(fullPath, "utf8")

				// Handle line ranges if specified
				let content: string
				if (entry.lineRanges && entry.lineRanges.length > 0) {
					const lines = rawContent.split("\n")
					const selectedLines: string[] = []

					for (const range of entry.lineRanges) {
						// Convert to 0-based index, ranges are 1-based inclusive
						const startIdx = Math.max(0, range.start - 1)
						const endIdx = Math.min(lines.length - 1, range.end - 1)

						for (let i = startIdx; i <= endIdx; i++) {
							selectedLines.push(`${i + 1} | ${lines[i]}`)
						}
					}
					content = selectedLines.join("\n")
				} else {
					// Full file in one approval (same chunking as executeNew slice mode)
					content = this.readFullFileInSliceMode(rawContent, {
						path: relPath,
						offset: 1,
						limit: DEFAULT_LINE_LIMIT,
					})
				}

				results.push(`File: ${relPath}\n${content}`)

				// Track file in context
				await task.fileContextTracker.trackFileContext(relPath, "read_tool")
			} catch (error) {
				const errorMsg = getErrorMessage(error)
				results.push(`File: ${relPath}\nError: ${errorMsg}`)
				await task.say("error", `Error reading file ${relPath}: ${errorMsg}`)
			}
		}

		// Push combined results
		pushToolResult(results.join("\n\n---\n\n"))
	}
}

export const readFileTool = new ReadFileTool()
