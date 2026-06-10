import * as vscode from "vscode"

import type { ApiHandler } from "../../api"
import { getBundledCangjieCorpusPath } from "../../utils/bundledCangjieCorpus"
import { regexSearchFiles } from "../ripgrep"

import { streamCompletionText } from "./completionStream"
import { normalizeInlineInsert } from "./completionPostProcess"
import {
	escapeRegexLiteral,
	formatCursorLineForPrompt,
	getIdentifierBeforeCursor,
	getLinesAfterCursor,
	getLinesBeforeCursor,
	INLINE_CURSOR_MARKER,
} from "./contextExtraction"

const SYSTEM = `You are an inline completion engine for the Cangjie (仓颉) programming language.
The prompt marks the insertion point with ${INLINE_CURSOR_MARKER} on the current line.
Output ONLY the new characters to insert there — no markdown fences, no explanations.
Never output the literal string ${INLINE_CURSOR_MARKER}.
Do not repeat the full current line, and do not duplicate text that already appears before or after ${INLINE_CURSOR_MARKER} on that line.
Follow Cangjie syntax and the references. Preserve indentation. Stop after a natural boundary within the line budget.
Use following lines only for scope context — do not duplicate them unless closing a block.`

const MAX_GREP_CHARS = 4000

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return s.slice(0, max) + "\n… [truncated]"
}

export class CangjieCompletionEngine {
	constructor(
		private readonly getApi: () => Promise<ApiHandler | undefined>,
		private readonly getTaskMeta: () => { taskId?: string; mode?: string },
		private readonly extensionPath: string,
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

		const contextBlock = getLinesBeforeCursor(document, position, 50)
		const line = document.lineAt(position.line)
		const prefixBeforeCursor = line.text.slice(0, position.character)
		const lineSuffixAfterCursor = line.text.slice(position.character)
		const following = getLinesAfterCursor(document, position, 12)
		const identifier = getIdentifierBeforeCursor(document, position)
		const meta = this.getTaskMeta()

		let grepRefs = ""
		const pattern =
			identifier.length >= 2
				? escapeRegexLiteral(identifier)
				: escapeRegexLiteral(line.text.trim().slice(0, 40) || "func")

		const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri)
		if (wsFolder && pattern.length >= 2) {
			try {
				const projectHits = await regexSearchFiles(wsFolder.uri.fsPath, wsFolder.uri.fsPath, pattern, "*.cj")
				grepRefs += `### Project (.cj)\n${truncate(projectHits, MAX_GREP_CHARS / 2)}\n\n`
			} catch {
				// intentionally ignored: regex search over project may fail
			}
		}

		const corpusRoot = getBundledCangjieCorpusPath(this.extensionPath)
		if (corpusRoot && pattern.length >= 2) {
			try {
				const corpusHits = await regexSearchFiles(corpusRoot, corpusRoot, pattern, "*.cj")
				grepRefs += `### CangjieCorpus\n${truncate(corpusHits, MAX_GREP_CHARS / 2)}\n\n`
			} catch {
				// intentionally ignored: regex search over corpus may fail
			}
		}

		const user = `File: ${document.fileName}
Identifier before cursor: ${identifier || "(none)"}

--- Code before cursor (50 lines max) ---
${contextBlock}
--- End code before cursor ---

--- Current line (${INLINE_CURSOR_MARKER} = insert here; text after ${INLINE_CURSOR_MARKER} is already in the file) ---
${formatCursorLineForPrompt(line.text, position.character)}
--- End current line ---

${following ? `--- Following lines (context only; do not duplicate) ---\n${following}\n--- End following ---\n` : ""}
References from ripgrep (may be partial):
${grepRefs || "(no ripgrep matches)"}

Insert only new Cangjie text at ${INLINE_CURSOR_MARKER}.`

		if (options.token.isCancellationRequested) {
			return undefined
		}

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
