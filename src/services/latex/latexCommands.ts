import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { Package } from "../../shared/package"
import { resolveLatexmkExecutable, resolvePdflatexExecutable } from "./latexResolve"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

const execFileAsync = promisify(execFile)

const LATEX_OUTPUT_CHANNEL = "LaTeX (NJUST_AI_CJ)"

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
			void vscode.window.showInformationMessage(
				"请先打开并聚焦 .tex / LaTeX 文件。本地编译需已安装 TeX Live 或 MiKTeX（latexmk 或 pdflatex）。",
			)
			return
		}

		if (editor.document.isUntitled) {
			void vscode.window.showWarningMessage("请先保存 LaTeX 文件再编译。")
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
			latexChannel.appendLine(`[LaTeX] 警告：已过滤不安全参数（-shell-escape 等）。`)
		}

		const safeEnvKeys = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG", "SystemRoot", "APPDATA", "LOCALAPPDATA"]
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
				latexChannel.appendLine("\n[LaTeX] 提示：pdflatex 单次运行可能不足以更新目录与交叉引用；建议使用 latexmk 引擎。")
			}

			const pdfPath = path.join(cwd, path.basename(texPath, path.extname(texPath)) + ".pdf")
			if (fs.existsSync(pdfPath)) {
				void vscode.window.showInformationMessage(`LaTeX 编译完成：${path.basename(pdfPath)}`)
				if (openPdf) {
					try {
						await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(pdfPath))
					} catch {
						await vscode.env.openExternal(vscode.Uri.file(pdfPath))
					}
				}
			} else {
				void vscode.window.showWarningMessage("编译已结束但未找到生成的 PDF，请查看输出面板中的日志。")
			}
		} catch (e) {
			const msg = getErrorMessage(e)
			latexChannel.appendLine(`\n[LaTeX] 错误: ${msg}`)
			TelemetryService.reportError(e instanceof Error ? e : new Error(msg), TelemetryEventName.UTILITY_ERROR)
			void vscode.window.showErrorMessage(
				`LaTeX 编译失败。请安装 MiKTeX 或 TeX Live，或将 MiKTeX 的 bin 加入系统 PATH；也可在设置中填写 njust-ai-cj.latex.latexmkPath（latexmk.exe 完整路径）。详情见输出「${LATEX_OUTPUT_CHANNEL}」。`,
			)
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand("njust-ai-cj.latexCompile", runCompile))
}
