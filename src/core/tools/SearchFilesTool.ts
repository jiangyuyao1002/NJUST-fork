import path from "path"
import { z } from "zod"

import { type ClineSayTool } from "@njust-ai-cj/types"

import { Task } from "../task/Task"
import { validateRegexPattern } from "../../utils/safeRegex"
import { getReadablePath } from "../../utils/path"
import { ignoreAbortError } from "../../utils/errorHandling"
import { isPathUnderBundledCangjieCorpus, isPathPotentiallyUnderCangjieCorpus, getBundledCangjieCorpusPath } from "../../utils/bundledCangjieCorpus"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { regexSearchFiles } from "../../services/ripgrep"
import {
	CangjieCorpusSemanticIndex,
	expandCangjieSemanticQuery,
	getCangjieSemanticIndexFingerprint,
} from "../../services/cangjie-corpus/CangjieCorpusSemanticIndex"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks, type ValidationResult } from "./BaseTool"
import { toolResultCache } from "./helpers/ToolResultCache"
import { extractStdModulesFromQuery } from "./cangjiePreflightCheck"

interface SearchFilesParams {
	path: string
	regex: string
	file_pattern?: string | null
	semantic_query?: string | null
}

let _semanticIndex: CangjieCorpusSemanticIndex | undefined
let _semanticCorpusRoot: string | undefined
let _semanticFingerprint: string | undefined

function getOrCreateCorpusSemanticIndex(corpusRoot: string): CangjieCorpusSemanticIndex {
	const fp = getCangjieSemanticIndexFingerprint(corpusRoot) ?? ""
	if (!_semanticIndex || _semanticCorpusRoot !== corpusRoot || _semanticFingerprint !== fp) {
		_semanticIndex = new CangjieCorpusSemanticIndex(corpusRoot)
		_semanticCorpusRoot = corpusRoot
		_semanticFingerprint = fp
	}
	return _semanticIndex
}

export class SearchFilesTool extends BaseTool<"search_files"> {
	readonly name = "search_files" as const
	override readonly maxResultSizeChars = 50_000
	override isConcurrencySafe(): boolean {
		return true
	}

	override getEagerExecutionDecision() { return "eager" as const }
	override isPartialArgsStable(partial: Partial<{path: string; regex: string; file_pattern?: string | null; semantic_query?: string | null}>): boolean {
		return typeof partial.path === "string" && typeof partial.regex === "string"
	}

	protected override get inputSchema() {
		return z.object({
			path: z.string().min(1, "path is required"),
			regex: z.string().min(1, "regex is required"),
			file_pattern: z.string().optional().nullable(),
			semantic_query: z.string().optional().nullable(),
		})
	}

	override validateInput(params: SearchFilesParams): ValidationResult {
		if (!params.regex || params.regex.trim() === "") {
			return { valid: false, error: "Search regex pattern is required and cannot be empty." }
		}
		// Validate regex safety (ReDoS protection + syntax)
		const regexSafety = validateRegexPattern(params.regex)
		if (!regexSafety.valid) {
			return { valid: false, error: `Invalid regex: ${regexSafety.reason}` }
		}
		if (!params.path || params.path.trim() === "") {
			return { valid: false, error: "Search path is required and cannot be empty." }
		}
		return { valid: true }
	}

	async execute(params: SearchFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const cacheKey = toolResultCache.makeKey("search_files", params)
		const cached = toolResultCache.get(cacheKey)
		if (cached) {
			pushToolResult(cached)
			return
		}

		const relDirPath = (params.path && params.path.trim().length > 0) ? params.path : "."
		const regex = params.regex
		const filePattern = params.file_pattern || undefined
		const semanticQuery = params.semantic_query || undefined

		if (!regex && !semanticQuery) {
			task.consecutiveMistakeCount++
			task.recordToolError("search_files")
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("search_files", "regex"))
			return
		}

		task.consecutiveMistakeCount = 0

		const absolutePath = path.resolve(task.cwd, relDirPath)
		const extensionPath = task.providerRef.deref()?.context.extensionPath
		const isOutsideWorkspace =
			isPathOutsideWorkspace(absolutePath) && !isPathUnderBundledCangjieCorpus(absolutePath, extensionPath)
		const isUnderCangjieCorpus = isPathUnderBundledCangjieCorpus(absolutePath, extensionPath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath),
			regex: regex ?? "",
			filePattern: filePattern,
			isOutsideWorkspace,
		}

		const trackCangjieSearchHistory = () => {
			if (isUnderCangjieCorpus && task.taskMode === "cangjie") {
				const stdModules = extractStdModulesFromQuery(regex, semanticQuery)
				for (const m of stdModules) task.cangjieSearchHistory.add(m)
				task.cangjieRuntimePolicy.noteCorpusSearch(stdModules, semanticQuery ?? regex)
			}
		}

		try {
			// Semantic search branch: use BM25 index when query targets bundled corpus
			if (semanticQuery && isUnderCangjieCorpus) {
				const corpusRoot = getBundledCangjieCorpusPath(extensionPath)
				if (corpusRoot) {
					const index = getOrCreateCorpusSemanticIndex(corpusRoot)

					if (index.isAvailable) {
						const pathPrefix = absolutePath !== corpusRoot
							? path.relative(corpusRoot, absolutePath).replace(/\\/g, "/")
							: undefined
						let hits = index.search(semanticQuery, 10, pathPrefix)
						if (hits.length === 0) {
							const expanded = expandCangjieSemanticQuery(semanticQuery)
							if (expanded !== semanticQuery) {
								hits = index.search(expanded, 10, pathPrefix)
							}
						}

						if (hits.length > 0) {
							const formatted = hits
								.map((h, i) => {
									const fullPath = path.join(corpusRoot, h.relPath).replace(/\\/g, "/")
									return `${i + 1}. ${h.relPath} (line ${h.startLine + 1}, score ${h.score.toFixed(2)})\n   ${h.heading}\n   ${h.snippet}\n   → read_file: ${fullPath}`
								})
								.join("\n\n")
							const result = `Semantic search results for: "${semanticQuery}"\n\n${formatted}`
							toolResultCache.set(cacheKey, result)
							trackCangjieSearchHistory()
							pushToolResult(result)
							return
						}
						// No results from semantic — fall through to regex
					}
				}
			}

			const results = await regexSearchFiles(task.cwd, absolutePath, regex || ".*", filePattern, task.rooIgnoreController)

			if (isUnderCangjieCorpus) {
				toolResultCache.set(cacheKey, results)
				trackCangjieSearchHistory()
				pushToolResult(results)
				return
			}

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: results } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(results)
		} catch (error) {
			await handleError("searching files", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"search_files">): Promise<void> {
		const relDirPath = block.params.path
		const regex = block.params.regex
		const filePattern = block.params.file_pattern
		const _semanticQueryParam = block.params.semantic_query // acknowledged but not displayed in partial

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const extensionPath = task.providerRef.deref()?.context.extensionPath
		const isOutsideWorkspace =
			isPathOutsideWorkspace(absolutePath) && !isPathUnderBundledCangjieCorpus(absolutePath, extensionPath)

		const sharedMessageProps: ClineSayTool = {
			tool: "searchFiles",
			path: getReadablePath(task.cwd, relDirPath ?? ""),
			regex: regex ?? "",
			filePattern: filePattern ?? "",
			isOutsideWorkspace,
		}

		if (isPathPotentiallyUnderCangjieCorpus(absolutePath, extensionPath, relDirPath)) {
			return
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const searchFilesTool = new SearchFilesTool()
