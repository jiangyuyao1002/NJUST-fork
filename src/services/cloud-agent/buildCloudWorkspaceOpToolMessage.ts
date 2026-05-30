import path from "path"
import fs from "fs/promises"

import type { ClineSayTool } from "@njust-ai/types"

import { formatResponse } from "../../core/prompts/responses"
import { computeDiffStats, convertNewFileToUnifiedDiff, sanitizeUnifiedDiff } from "../../core/diff/stats"
import { MultiSearchReplaceDiffStrategy } from "../../core/diff/strategies/multi-search-replace"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"

import type { WorkspaceOp } from "./types"

export interface BuildCloudWorkspaceOpToolMessageOptions {
	isWriteProtected: boolean
}

/**
 * Build JSON for ask("tool", ...) so ChatRow renders the same approval UI as native write/apply_diff tools.
 */
export async function buildCloudWorkspaceOpToolMessage(
	cwd: string,
	op: WorkspaceOp,
	options: BuildCloudWorkspaceOpToolMessageOptions,
): Promise<string> {
	const isProtected = options.isWriteProtected
	const relPath = op.path
	const fullPath = path.resolve(cwd, relPath)
	const readablePath = getReadablePath(cwd, relPath)
	const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

	if (op.op === "write_file") {
		const fileExists = await fileExistsAtPath(fullPath)
		const tool = fileExists ? "editedExistingFile" : "newFileCreated"
		let content: string
		let diffStats: ClineSayTool["diffStats"]
		if (fileExists) {
			const originalContent = await fs.readFile(fullPath, "utf-8")
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, op.content)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			content = unifiedPatch
			diffStats = computeDiffStats(unifiedPatch) || undefined
		} else {
			const unifiedPatchRaw = convertNewFileToUnifiedDiff(op.content, relPath)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			content = unifiedPatch
			diffStats = computeDiffStats(unifiedPatch) || undefined
		}
		const payload: ClineSayTool = {
			tool,
			path: readablePath,
			content,
			diffStats,
			isOutsideWorkspace,
			isProtected,
		}
		return JSON.stringify(payload)
	}

	const diffContent = op.diff
	const fileExists = await fileExistsAtPath(fullPath)
	let originalContent = ""
	if (fileExists) {
		originalContent = await fs.readFile(fullPath, "utf-8")
	}

	const strategy = new MultiSearchReplaceDiffStrategy()
	const diffResult = fileExists
		? await strategy.applyDiff(originalContent, diffContent)
		: { success: false as const, error: "File not found" }

	let unifiedPatch: string
	let diffStats: ClineSayTool["diffStats"]
	if (diffResult.success && "content" in diffResult) {
		const raw = formatResponse.createPrettyPatch(relPath, originalContent, diffResult.content)
		unifiedPatch = sanitizeUnifiedDiff(raw)
		diffStats = computeDiffStats(unifiedPatch) || undefined
	} else {
		unifiedPatch = diffContent
		diffStats = undefined
	}

	const payload: ClineSayTool = {
		tool: "appliedDiff",
		path: readablePath,
		diff: diffContent,
		content: unifiedPatch,
		...(fileExists ? { originalContent } : {}),
		diffStats,
		isOutsideWorkspace,
		isProtected,
	}
	return JSON.stringify(payload)
}
