import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { execFile } from "child_process"
import { promisify } from "util"
import { resolveCangjieToolPath, buildCangjieToolEnv, CJC_CONFIG_KEY } from "./cangjieToolUtils"
import type { CangjieSymbolIndex } from "./CangjieSymbolIndex"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { t } from "../../i18n"

const execFileAsync = promisify(execFile)

async function formatExpandedCangjieWithCjfmt(expanded: string, outputChannel: vscode.OutputChannel): Promise<string> {
	const cjfmtPath = resolveCangjieToolPath("cjfmt", "cangjieTools.cjfmtPath")
	if (!cjfmtPath) return expanded

	const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
	const tmpIn = path.join(os.tmpdir(), `cjc_expand_${id}.cj`)
	const tmpOut = path.join(os.tmpdir(), `cjc_expand_${id}_out.cj`)
	try {
		fs.writeFileSync(tmpIn, expanded, "utf-8")
		await execFileAsync(cjfmtPath, ["-f", tmpIn, "-o", tmpOut], {
			timeout: 15_000,
			env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
		})
		if (fs.existsSync(tmpOut)) {
			return fs.readFileSync(tmpOut, "utf-8")
		}
	} catch (e) {
		const msg = getErrorMessage(e)
		outputChannel.appendLine(`[MacroExpand] cjfmt skipped: ${msg}`)
		TelemetryService.reportError(e, TelemetryEventName.CANGJIE_LSP_ERROR)
	} finally {
		try {
			fs.unlinkSync(tmpIn)
		} catch {
			// intentionally ignored: temp file cleanup
		}
		try {
			fs.unlinkSync(tmpOut)
		} catch {
			// intentionally ignored: temp file cleanup
		}
	}
	return expanded
}

const MACRO_CALL_RE = /@(\w+)(?=\s*\(|\s+\w|$)/g
const _MACRO_DEF_RE = /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)*macro\s+(\w+)/

/**
 * CodeLens provider that shows "Expand Macro" / "Go to Macro Definition"
 * above lines containing macro invocations (@MacroName).
 */
export class CangjieMacroCodeLensProvider implements vscode.CodeLensProvider {
	constructor(private readonly index: CangjieSymbolIndex) {}

	provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = []

		for (let i = 0; i < document.lineCount; i++) {
			const lineText = document.lineAt(i).text
			MACRO_CALL_RE.lastIndex = 0
			let match: RegExpExecArray | null

			while ((match = MACRO_CALL_RE.exec(lineText)) !== null) {
				const macroName = match[1]!
				if (this.isBuiltinAnnotation(macroName)) continue

				const range = new vscode.Range(i, 0, i, 0)

				const macroDefs = this.index.findDefinitionsByKind(macroName, "macro")
				if (macroDefs.length > 0) {
					lenses.push(
						new vscode.CodeLens(range, {
							title: `$(symbol-event) ${t("code_actions.cangjie_lsp.go_to_macro_def")}: ${macroName}`,
							command: "njust-ai.cangjieGoToMacroDef",
							arguments: [macroDefs[0]!.filePath, macroDefs[0]!.startLine],
						}),
					)
				}

				lenses.push(
					new vscode.CodeLens(range, {
						title: `$(unfold) ${t("code_actions.cangjie_lsp.expand_macro")}: @${macroName}`,
						command: "njust-ai.cangjieExpandMacro",
						arguments: [document.uri, i],
					}),
				)
			}
		}

		return lenses
	}

	private isBuiltinAnnotation(name: string): boolean {
		return ["Test", "TestCase", "Assert", "Deprecated", "Suppress", "Override"].includes(name)
	}
}

/**
 * Hover provider that shows macro expansion preview when hovering over @MacroName.
 */
export class CangjieMacroHoverProvider implements vscode.HoverProvider {
	constructor(private readonly index: CangjieSymbolIndex) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		const lineText = document.lineAt(position.line).text
		MACRO_CALL_RE.lastIndex = 0
		let match: RegExpExecArray | null

		while ((match = MACRO_CALL_RE.exec(lineText)) !== null) {
			const macroName = match[1]!
			const atIndex = match.index + (match[0].length - macroName.length - 1)
			const nameStart = atIndex + 1

			if (position.character >= atIndex && position.character <= nameStart + macroName.length) {
				const defs = this.index.findDefinitionsByKind(macroName, "macro")

				const md = new vscode.MarkdownString()
				md.appendMarkdown(`**${t("tooltips.cangjie_lsp.macro_call")}:** \`@${macroName}\`\n\n`)

				if (defs.length > 0) {
					const def = defs[0]!
					md.appendMarkdown(
						`**${t("tooltips.cangjie_lsp.macro_def_location")}:** ${path.basename(def.filePath)}:${def.startLine + 1}\n\n`,
					)
					md.appendCodeblock(def.signature, "cangjie")
				} else {
					md.appendMarkdown(`*${t("tooltips.cangjie_lsp.macro_not_in_index")}*`)
				}

				return new vscode.Hover(
					md,
					new vscode.Range(position.line, atIndex, position.line, nameStart + macroName.length),
				)
			}
		}

		return undefined
	}
}

/**
 * Register commands for macro expansion and navigation.
 */
export function registerMacroCommands(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieGoToMacroDef", async (filePath: string, startLine: number) => {
			const uri = vscode.Uri.file(filePath)
			const doc = await vscode.workspace.openTextDocument(uri)
			const editor = await vscode.window.showTextDocument(doc)
			const pos = new vscode.Position(startLine, 0)
			editor.selection = new vscode.Selection(pos, pos)
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieExpandMacro", async (uri: vscode.Uri, _line: number) => {
			const cjcPath = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY)
			if (!cjcPath) {
				vscode.window.showWarningMessage(t("warnings.cangjie_lsp.cjc_not_found_for_macro"))
				return
			}

			const filePath = uri.fsPath
			if (!fs.existsSync(filePath)) return

			try {
				const { stdout, stderr } = await execFileAsync(
					cjcPath,
					["--expand-macros", "--dump-to-screen", filePath],
					{ timeout: 15_000, env: buildCangjieToolEnv() as NodeJS.ProcessEnv },
				)

				let expanded = stdout
				if (stderr?.trim()) {
					logger.warn("CangjieMacro", `cjc stderr:\n${stderr}`)
				}
				if (!expanded || expanded.trim().length === 0) {
					vscode.window.showInformationMessage(t("info.cangjie_lsp.macro_expand_no_output"))
					return
				}

				expanded = await formatExpandedCangjieWithCjfmt(expanded, outputChannel)

				const doc = await vscode.workspace.openTextDocument({
					content: expanded,
					language: "cangjie",
				})
				await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside })
			} catch (err) {
				const msg = getErrorMessage(err)
				outputChannel.appendLine(`[MacroExpand] Error: ${msg}`)
				TelemetryService.reportError(err, TelemetryEventName.CANGJIE_LSP_ERROR)

				if (msg.includes("--expand-macros")) {
					vscode.window.showWarningMessage(t("warnings.cangjie_lsp.cjc_no_expand_macros"))
				} else {
					vscode.window.showWarningMessage(t("warnings.cangjie_lsp.macro_expand_failed", { msg }))
				}
			}
		}),
	)
}
