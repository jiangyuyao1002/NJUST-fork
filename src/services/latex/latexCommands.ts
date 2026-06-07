import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { Package } from "../../shared/package"
import { resolveLatexmkExecutable, resolvePdflatexExecutable } from "./latexResolve"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { t } from "../../i18n"

const execFileAsync = promisify(execFile)

const LATEX_OUTPUT_CHANNEL = "LaTeX (NJUST_AI)"

function isLatexDocument(doc: vscode.TextDocument): boolean {
	if (doc.languageId === "latex" || doc.languageId === "tex") return true
	const ext = path.extname(doc.fileName).toLowerCase()
	return ext === ".tex" || ext === ".ltx"
}

/**
 * Local LaTeX compile (TeX Live / MiKTeX). Similar workflow to Overleaf's "Recompile",
 * but runs on your machine — not on overleaf.com.
 */
export function registerLatexCommands(context: vscode.ExtensionContext, _outputChannel: vscode.OutputChannel): void {
	const latexChannel = vscode.window.createOutputChannel(LATEX_OUTPUT_CHANNEL)
	context.subscriptions.push(latexChannel)

	const runCompile = async () => {
		const editor = vscode.window.activeTextEditor
		if (!editor || !isLatexDocument(editor.document)) {
			void vscode.window.showInformationMessage(t("info.latex_focus_file_first"))
			return
		}

		if (editor.document.isUntitled) {
			void vscode.window.showWarningMessage(t("warnings.latex_save_first"))
			return
		}

		const texPath = editor.document.uri.fsPath
		const cwd = path.dirname(texPath)
		const base = path.basename(texPath)
		const cfg = vscode.workspace.getConfiguration(Package.name)
		const engine = (cfg.get<string>("latex.engine") ?? "latexmk").toLowerCase()
		const openPdf = cfg.get<boolean>("latex.openPdfAfterSuccess") ?? true
		const rawExtra = cfg.get<string[]>("latex.extraArgs") ?? []
		const BLOCKED_ARGS = ["-shell-escape", "--shell-escape", "-enable-write18", "--enable-write18"]
		const extra = rawExtra.filter((arg) => !BLOCKED_ARGS.includes(arg.toLowerCase()))
		if (extra.length !== rawExtra.length) {
			latexChannel.appendLine(t("warnings.latex_unsafe_args_filtered"))
		}

		const safeEnvKeys = [
			"PATH",
			"HOME",
			"USERPROFILE",
			"TEMP",
			"TMP",
			"TEXMFHOME",
			"TEXMFVAR",
			"TEXMFCONFIG",
			"SystemRoot",
			"APPDATA",
			"LOCALAPPDATA",
		]
		const safeEnv: Record<string, string> = {}
		for (const key of safeEnvKeys) {
			if (process.env[key]) safeEnv[key] = process.env[key]!
		}

		latexChannel.clear()
		latexChannel.show(true)
		latexChannel.appendLine(`[LaTeX] cwd: ${cwd}`)
		latexChannel.appendLine(`[LaTeX] file: ${base}`)
		latexChannel.appendLine(`[LaTeX] engine: ${engine}`)
		latexChannel.appendLine("")

		try {
			if (engine === "latexmk") {
				const latexmk = resolveLatexmkExecutable(cfg.get<string>("latex.latexmkPath"))
				const args = ["-pdf", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", ...extra, base]
				latexChannel.appendLine(`$ ${latexmk} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`)
				const { stdout, stderr } = await execFileAsync(latexmk, args, {
					cwd,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
					env: safeEnv,
				})
				if (stdout) latexChannel.appendLine(stdout)
				if (stderr) latexChannel.appendLine(stderr)
			} else {
				const pdflatex = resolvePdflatexExecutable(cfg.get<string>("latex.pdflatexPath"))
				const args = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1", ...extra, base]
				latexChannel.appendLine(`$ ${pdflatex} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`)
				const { stdout, stderr } = await execFileAsync(pdflatex, args, {
					cwd,
					maxBuffer: 20 * 1024 * 1024,
					windowsHide: true,
					env: safeEnv,
				})
				if (stdout) latexChannel.appendLine(stdout)
				if (stderr) latexChannel.appendLine(stderr)
				latexChannel.appendLine(t("info.latex_pdflatex_hint"))
			}

			const pdfPath = path.join(cwd, path.basename(texPath, path.extname(texPath)) + ".pdf")
			if (fs.existsSync(pdfPath)) {
				void vscode.window.showInformationMessage(
					t("info.latex_compile_success", { filename: path.basename(pdfPath) }),
				)
				if (openPdf) {
					try {
						await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdfPath))
					} catch {
						await vscode.env.openExternal(vscode.Uri.file(pdfPath))
					}
				}
			} else {
				void vscode.window.showWarningMessage(t("warnings.latex_no_pdf_found"))
			}
		} catch (e) {
			const msg = getErrorMessage(e)
			latexChannel.appendLine(t("errors.latex_error_log", { msg }))
			TelemetryService.reportError(e instanceof Error ? e : new Error(msg), TelemetryEventName.UTILITY_ERROR)
			void vscode.window.showErrorMessage(t("errors.latex_compile_failed"))
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand("njust-ai.latexCompile", runCompile))
}
