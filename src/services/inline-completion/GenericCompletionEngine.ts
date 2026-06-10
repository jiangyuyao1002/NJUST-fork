import * as vscode from "vscode"

import type { ApiHandler } from "../../api"

import { streamCompletionText } from "./completionStream"
import { normalizeInlineInsert } from "./completionPostProcess"
import {
	formatCursorLineForPrompt,
	getLinesAfterCursor,
	getLinesBeforeCursor,
	INLINE_CURSOR_MARKER,
} from "./contextExtraction"

const SYSTEM = `You are an inline code completion engine. The user prompt marks the insertion point with ${INLINE_CURSOR_MARKER} on the current line.
Output ONLY the new characters to insert at that point — no markdown fences, no explanations, no quotes around the whole answer.
Never output the literal string ${INLINE_CURSOR_MARKER}.
Do not repeat the full current line, and do not duplicate text that already appears before or after ${INLINE_CURSOR_MARKER} on that line.
Preserve indentation. Use the following lines only for bracket/scope context — do not copy them into the completion unless you are closing an open block naturally.
Stop when the logical statement or block is complete.`

export class GenericCompletionEngine {
	constructor(
		private readonly getApi: () => Promise<ApiHandler | undefined>,
		private readonly getTaskMeta: () => { taskId?: string; mode?: string },
	) {}

	async run(
		document: vscode.TextDocument,
		position: vscode.Position,
		options: { maxLines: number; token: vscode.CancellationToken },
	): Promise<string | undefined> {
		const api = await this.getApi()
		if (!api) {
			return undefined
		}

		const contextBlock = getLinesBeforeCursor(document, position, 30)
		const line = document.lineAt(position.line)
		const prefixBeforeCursor = line.text.slice(0, position.character)
		const lineSuffixAfterCursor = line.text.slice(position.character)
		const following = getLinesAfterCursor(document, position, 12)
		const meta = this.getTaskMeta()

		const user = `File: ${document.fileName}
Language: ${document.languageId}

--- Code before cursor ---
${contextBlock}
--- End code before cursor ---

--- Current line (${INLINE_CURSOR_MARKER} = insert here; text after ${INLINE_CURSOR_MARKER} is already in the file) ---
${formatCursorLineForPrompt(line.text, position.character)}
--- End current line ---

${following ? `--- Following lines (context only; do not duplicate) ---\n${following}\n--- End following ---\n` : ""}
Insert only new text at ${INLINE_CURSOR_MARKER}.`

		let raw = await streamCompletionText(api, SYSTEM, user, {
			token: options.token,
			taskId: meta.taskId,
			mode: meta.mode,
		})
		raw = normalizeInlineInsert(raw, {
			prefixBeforeCursor,
			lineSuffixAfterCursor,
			fullLineText: line.text,
			maxLines: options.maxLines,
		})
		if (!raw.trim()) {
			return undefined
		}
		return raw
	}
}
