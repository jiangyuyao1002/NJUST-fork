import * as vscode from "vscode"

/** Marker inserted into prompts so the model sees exactly where insertion happens (avoid emitting this literal in output). */
export const INLINE_CURSOR_MARKER = "[CURSOR]"

export function getLinesBeforeCursor(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxLines: number,
): string {
	const startLine = Math.max(0, position.line - (maxLines - 1))
	const range = new vscode.Range(startLine, 0, position.line, position.character)
	return document.getText(range)
}

/**
 * Lines strictly below the cursor (not including the current line).
 * Bounded by `maxLines` and approximate `maxChars` to keep prompts small.
 */
export function getLinesAfterCursor(
	document: vscode.TextDocument,
	position: vscode.Position,
	maxLines: number,
	maxChars = 6000,
): string {
	if (position.line >= document.lineCount - 1 || maxLines <= 0) {
		return ""
	}
	const endLine = Math.min(document.lineCount - 1, position.line + maxLines)
	const parts: string[] = []
	let total = 0
	for (let line = position.line + 1; line <= endLine; line++) {
		const t = document.lineAt(line).text
		const sep = parts.length > 0 ? 1 : 0
		if (total + sep + t.length > maxChars) {
			const room = maxChars - total - sep
			if (room > 0) {
				parts.push(t.slice(0, room))
			}
			break
		}
		parts.push(t)
		total += sep + t.length
	}
	return parts.join("\n")
}

/** Current line with a visible cursor marker between prefix and suffix (suffix is already in the file after the caret). */
export function formatCursorLineForPrompt(lineText: string, character: number): string {
	const safeChar = Math.max(0, Math.min(character, lineText.length))
	const prefix = lineText.slice(0, safeChar)
	const suffix = lineText.slice(safeChar)
	return `${prefix}${INLINE_CURSOR_MARKER}${suffix}`
}

export function getIdentifierBeforeCursor(document: vscode.TextDocument, position: vscode.Position): string {
	const line = document.lineAt(position.line).text
	const before = line.slice(0, position.character)
	const m = /[\w\u4e00-\u9fff]+$/.exec(before)
	return m ? m[0] : ""
}

export function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
