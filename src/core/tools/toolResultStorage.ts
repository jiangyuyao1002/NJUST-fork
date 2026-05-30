import * as fs from "fs/promises"
import * as path from "path"

export interface StoredToolResult {
	filePath: string // 持久化文件的绝对路径
	preview: string // 前 N 行预览
	totalLines: number // 结果总行数
	totalChars: number // 结果总字符数
}

// 阈值：超过此大小的结果将被持久化
const RESULT_STORAGE_THRESHOLD = 100 * 1024 // 100KB

/**
 * Check if a tool result should be persisted to disk.
 * @param result The tool result string to check.
 * @param maxResultSizeChars Optional per-tool threshold in characters.
 *   When provided, overrides the default 100KB threshold.
 */
export function shouldPersistResult(result: string, maxResultSizeChars?: number): boolean {
	const threshold = maxResultSizeChars ?? RESULT_STORAGE_THRESHOLD
	return result.length > threshold
}

/**
 * Persist a large tool result to disk and return a preview
 */
export async function persistToolResult(
	result: string,
	taskId: string,
	toolUseId: string,
	cwd: string,
): Promise<StoredToolResult> {
	// 存储到 .njust-ai/tool-results/{taskId}/{toolUseId}.txt
	const storageDir = path.join(cwd, ".njust-ai", "tool-results", taskId)
	await fs.mkdir(storageDir, { recursive: true })
	const filePath = path.join(storageDir, `${toolUseId}.txt`)
	await fs.writeFile(filePath, result, "utf-8")

	// 生成预览（前 50 行）
	const lines = result.split("\n")
	const previewLines = lines.slice(0, 50)
	const preview = previewLines.join("\n")

	return {
		filePath,
		preview,
		totalLines: lines.length,
		totalChars: result.length,
	}
}

/**
 * Format a stored result as a message for the model
 */
export function formatStoredResultMessage(stored: StoredToolResult): string {
	return `${stored.preview}\n\n---\n[Result truncated. Full result (${stored.totalLines} lines, ${stored.totalChars} chars) saved to: ${stored.filePath}]\n[Use read_file to view the complete result]`
}
