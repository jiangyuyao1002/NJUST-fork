import * as vscode from "vscode"
import { execFile } from "child_process"
import { promisify } from "util"
import type { CangjieLspState, CangjieLspClient } from "./CangjieLspClient"
import type { CangjieCompileGuard } from "./CangjieCompileGuard"
import { resolveCangjieToolPath, buildCangjieToolEnv, CJC_CONFIG_KEY } from "./cangjieToolUtils"
import { t } from "../../i18n"

const execFileAsync = promisify(execFile)
const LSP_OUTPUT_COMMAND = "njust-ai.cangjieShowLspOutput"
const COMPILE_OUTPUT_COMMAND = "njust-ai.cangjieShowCompileOutput"

export class CangjieLspStatusBar implements vscode.Disposable {
	private lspItem: vscode.StatusBarItem
	private compileItem: vscode.StatusBarItem
	private disposables: vscode.Disposable[] = []
	private sdkVersion: string | undefined
	private compileGuardUnsub: vscode.Disposable | undefined
	private compilePhase: "idle" | "busy" = "idle"

	constructor(
		lspClient: CangjieLspClient,
		lspOutputChannel: vscode.OutputChannel,
		/** Main extension / compile guard log */
		private readonly buildOutputChannel: vscode.OutputChannel,
	) {
		this.lspItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
		this.lspItem.command = LSP_OUTPUT_COMMAND

		this.compileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49)
		this.compileItem.command = COMPILE_OUTPUT_COMMAND

		this.disposables.push(
			vscode.commands.registerCommand(LSP_OUTPUT_COMMAND, () => {
				lspOutputChannel.show(true)
			}),
		)
		this.disposables.push(
			vscode.commands.registerCommand(COMPILE_OUTPUT_COMMAND, () => {
				this.buildOutputChannel.show(true)
			}),
		)

		this.disposables.push(lspClient.onStateChange((state, message) => this.updateLspState(state, message)))

		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				this.updateVisibility(editor)
			}),
		)

		this.updateLspState(lspClient.state)
		this.resetCompileStatus()
		this.updateVisibility(vscode.window.activeTextEditor)
		void this.detectSdkVersion()
	}

	/** Call when {@link CangjieCompileGuard} is created (lazy activation). */
	attachCompileGuard(guard: CangjieCompileGuard): void {
		if (this.compileGuardUnsub) {
			const prev = this.compileGuardUnsub
			this.compileGuardUnsub = undefined
			prev.dispose()
			const idx = this.disposables.indexOf(prev)
			if (idx >= 0) this.disposables.splice(idx, 1)
		}
		this.compileGuardUnsub = guard.onCompile((ev) => {
			if (ev.status === "start") {
				this.compilePhase = "busy"
				this.compileItem.text = `$(sync~spin) ${t("status.cangjie_lsp.compile_compiling")}`
				this.compileItem.tooltip = t("tooltips.cangjie_lsp.compile_in_progress")
				this.compileItem.backgroundColor = undefined
				this.compileItem.show()
				return
			}
			this.compilePhase = "idle"
			const sec = ev.durationMs != null ? (ev.durationMs / 1000).toFixed(1) : "?"
			if (ev.success) {
				const mode = ev.incremental ? t("status.cangjie_lsp.incremental") : t("status.cangjie_lsp.full")
				let tip = t("tooltips.cangjie_lsp.last_compile", { sec, mode })
				if (
					ev.incremental &&
					ev.lastFullBuildMs &&
					ev.durationMs != null &&
					ev.lastFullBuildMs > ev.durationMs
				) {
					const fullSec = (ev.lastFullBuildMs / 1000).toFixed(1)
					const savePct = Math.round(((ev.lastFullBuildMs - ev.durationMs) / ev.lastFullBuildMs) * 100)
					tip += t("tooltips.cangjie_lsp.incremental_savings", { fullSec, savePct })
				}
				this.compileItem.text = ev.incremental
					? `$(check) Cangjie ${sec}s (${t("status.cangjie_lsp.incremental")})`
					: `$(check) Cangjie ${sec}s (${t("status.cangjie_lsp.full")})`
				this.compileItem.tooltip = tip
				this.compileItem.backgroundColor = undefined
			} else {
				const n = ev.errorCount ?? 0
				this.compileItem.text = `$(error) Cangjie ${n} error${n === 1 ? "" : "s"} · ${sec}s`
				this.compileItem.tooltip = t("tooltips.cangjie_lsp.compile_failed")
				this.compileItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
			}
			this.updateVisibility(vscode.window.activeTextEditor)
		})
		this.disposables.push(this.compileGuardUnsub)
	}

	private resetCompileStatus(): void {
		this.compilePhase = "idle"
		this.compileItem.text = `$(tools) ${t("status.cangjie_lsp.compile_idle")}`
		this.compileItem.tooltip = t("tooltips.cangjie_lsp.compile_idle")
		this.compileItem.backgroundColor = undefined
	}

	private async detectSdkVersion(): Promise<void> {
		try {
			const cjcPath = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY)
			if (!cjcPath) return
			const { stdout } = await execFileAsync(cjcPath, ["--version"], {
				timeout: 5_000,
				env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
			})
			const firstLine = stdout.trim().split("\n")[0]
			if (firstLine) {
				this.sdkVersion = firstLine
				this.updateLspState(this._lastState, this._lastMessage)
			}
		} catch {
			// SDK not available — no version display
		}
	}

	private _lastState: CangjieLspState = "idle"
	private _lastMessage: string | undefined

	private updateLspState(state: CangjieLspState, message?: string): void {
		this._lastState = state
		this._lastMessage = message
		const versionSuffix = this.sdkVersion ? ` (${this.sdkVersion})` : ""

		switch (state) {
			case "idle":
				this.lspItem.text = "$(circle-outline) Cangjie LSP"
				this.lspItem.tooltip = t("tooltips.cangjie_lsp.lsp_idle", { version: versionSuffix })
				this.lspItem.backgroundColor = undefined
				break
			case "starting":
				this.lspItem.text = "$(sync~spin) Cangjie LSP"
				this.lspItem.tooltip = t("tooltips.cangjie_lsp.lsp_starting", { version: versionSuffix })
				this.lspItem.backgroundColor = undefined
				break
			case "running":
				this.lspItem.text = this.sdkVersion ? `$(check) Cangjie ${this.sdkVersion}` : "$(check) Cangjie LSP"
				this.lspItem.tooltip = t("tooltips.cangjie_lsp.lsp_running", { version: versionSuffix })
				this.lspItem.backgroundColor = undefined
				break
			case "warning":
				this.lspItem.text = "$(warning) Cangjie LSP"
				this.lspItem.tooltip = message
					? t("tooltips.cangjie_lsp.lsp_warning", { message, version: versionSuffix })
					: t("tooltips.cangjie_lsp.lsp_abnormal", { version: versionSuffix })
				this.lspItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
				break
			case "error":
				this.lspItem.text = "$(error) Cangjie LSP"
				this.lspItem.tooltip = message
					? t("tooltips.cangjie_lsp.lsp_error", { message, version: versionSuffix })
					: t("tooltips.cangjie_lsp.lsp_start_failed", { version: versionSuffix })
				this.lspItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground")
				break
			case "stopped":
				this.lspItem.text = "$(circle-slash) Cangjie LSP"
				this.lspItem.tooltip = t("tooltips.cangjie_lsp.lsp_stopped", { version: versionSuffix })
				this.lspItem.backgroundColor = undefined
				break
		}
	}

	private updateVisibility(editor: vscode.TextEditor | undefined): void {
		const cangjie = editor && (editor.document.languageId === "cangjie" || editor.document.fileName.endsWith(".cj"))
		if (cangjie) {
			this.lspItem.show()
			this.compileItem.show()
		} else {
			this.lspItem.hide()
			if (this.compilePhase === "busy") {
				this.compileItem.show()
			} else {
				this.compileItem.hide()
			}
		}
	}

	dispose(): void {
		this.compileGuardUnsub?.dispose()
		this.lspItem.dispose()
		this.compileItem.dispose()
		this.disposables.forEach((d) => d.dispose())
	}
}
