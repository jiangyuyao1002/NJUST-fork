import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { detectCangjieHome } from "./cangjieToolUtils"
import type { CangjieCompileGuard } from "./CangjieCompileGuard"
import { Package } from "../../shared/package"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai/telemetry"
import { TelemetryEventName } from "@njust-ai/types"
import { t } from "../../i18n"

/**
 * Provides a DebugAdapterDescriptor for the "cangjie" debug type.
 * Looks for the CJDB debugger executable in the Cangjie SDK.
 * Supports hot-reload: when a .cj file is saved during a debug session,
 * the changed module is recompiled and (if cjdb supports it) hot-swapped.
 */
const HOT_RELOAD_DAP_TIMEOUT_MS = 2000

function substituteWorkspaceFolder(program: string, workspaceRoot?: string): string {
	if (!workspaceRoot) return program
	return program.replace(/\$\{workspaceFolder\}/gi, workspaceRoot)
}

/**
 * Find a runnable under target/ when the default `target/output` is missing.
 */
function findCangjieExecutableInTarget(workspaceRoot: string): string | undefined {
	const targetDir = path.join(workspaceRoot, "target")
	if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
		return undefined
	}

	const preferred =
		process.platform === "win32"
			? [path.join(targetDir, "output.exe"), path.join(targetDir, "output")]
			: [path.join(targetDir, "output")]
	for (const p of preferred) {
		try {
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
		} catch {
			/* ignore */
		}
	}

	const maxDepth = 3
	const walk = (dir: string, depth: number): string | undefined => {
		if (depth > maxDepth) return undefined
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return undefined
		}
		for (const e of entries) {
			if (e.name.startsWith(".") || e.name === "deps" || e.name === "incremental") continue
			const full = path.join(dir, e.name)
			if (e.isDirectory()) {
				const hit = walk(full, depth + 1)
				if (hit) return hit
			} else if (e.isFile()) {
				if (process.platform === "win32") {
					if (e.name.endsWith(".exe")) return full
				} else if (e.name === "output" || !e.name.includes(".")) {
					// Check executable permission on Unix to avoid returning data files.
					try {
						const s = fs.statSync(full, { throwIfNoEntry: true } as UnsafeAny)
						if ((s.mode & 0o111) === 0) continue
					} catch {
						continue
					}
					return full
				}
			}
		}
		return undefined
	}

	return walk(targetDir, 0)
}

export class CangjieDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory, vscode.Disposable {
	private disposables: vscode.Disposable[] = []
	private activeSession: vscode.DebugSession | undefined
	private hotReloadWatcher: vscode.Disposable | undefined
	private compileGuard: CangjieCompileGuard | undefined

	constructor(
		compileGuard?: CangjieCompileGuard,
		private readonly logChannel?: vscode.OutputChannel,
	) {
		this.compileGuard = compileGuard
	}

	/** Called when CangjieCompileGuard is created lazily (after first .cj activation). */
	setCompileGuard(guard: CangjieCompileGuard | undefined): void {
		this.compileGuard = guard
	}

	createDebugAdapterDescriptor(
		session: vscode.DebugSession,
		_executable: vscode.DebugAdapterExecutable | undefined,
	): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
		const cangjieHome = detectCangjieHome()
		if (!cangjieHome) {
			vscode.window.showErrorMessage(t("errors.cangjie_lsp.cangjie_home_not_found"))
			return undefined
		}

		const debuggerPath = this.resolveDebuggerPath(cangjieHome)
		if (!debuggerPath) {
			vscode.window.showErrorMessage(t("errors.cangjie_lsp.debugger_not_found", { cangjieHome }))
			return undefined
		}

		this.activeSession = session
		this.startHotReloadWatcher(session)

		const args = ((session.configuration.debuggerArgs as string[]) || []).filter(
			(a) => typeof a === "string" && /^--[a-zA-Z][a-zA-Z0-9._-]*(?:[=:].+)?$/.test(a),
		)
		return new vscode.DebugAdapterExecutable(debuggerPath, ["--dap", ...args])
	}

	/**
	 * Watch for .cj file saves during debug and trigger incremental recompile.
	 * If the debug adapter supports hot-swap, the updated module is swapped in.
	 */
	private startHotReloadWatcher(session: vscode.DebugSession): void {
		this.stopHotReloadWatcher()

		const hotReloadEnabled = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("cangjieTools.hotReload", false)

		if (!hotReloadEnabled || !this.compileGuard) return

		this.hotReloadWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (doc.languageId !== "cangjie" && !doc.fileName.endsWith(".cj")) return
			if (!this.activeSession) return

			const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
			if (!folder) return

			const cwd = folder.uri.fsPath
			const cjpmToml = path.join(cwd, "cjpm.toml")
			if (!fs.existsSync(cjpmToml)) return

			const result = await this.compileGuard!.compile(cwd)
			if (result.success) {
				try {
					await Promise.race([
						session.customRequest("hotReload", {
							file: doc.fileName,
						}),
						new Promise<never>((_, reject) =>
							setTimeout(() => reject(new Error("hotReload timeout")), HOT_RELOAD_DAP_TIMEOUT_MS),
						),
					])
				} catch (e) {
					const msg = getErrorMessage(e)
					this.logChannel?.appendLine(`[Cangjie DAP] hotReload skipped or timed out: ${msg}`)
					TelemetryService.reportError(e, TelemetryEventName.CANGJIE_LSP_ERROR)
				}
			}
		})

		// Clean up when the session ends
		const sessionEnd = vscode.debug.onDidTerminateDebugSession((s) => {
			if (s === session) {
				this.stopHotReloadWatcher()
				this.activeSession = undefined
				sessionEnd.dispose()
			}
		})
		this.disposables.push(sessionEnd)
	}

	private stopHotReloadWatcher(): void {
		this.hotReloadWatcher?.dispose()
		this.hotReloadWatcher = undefined
	}

	private resolveDebuggerPath(cangjieHome: string): string | undefined {
		const exeName = process.platform === "win32" ? "cjdb.exe" : "cjdb"
		const candidates = [path.join(cangjieHome, "tools", "bin", exeName), path.join(cangjieHome, "bin", exeName)]
		return candidates.find((p) => fs.existsSync(p))
	}

	dispose(): void {
		this.stopHotReloadWatcher()
		this.disposables.forEach((d) => d.dispose())
	}
}

/**
 * Provides initial launch.json configurations for the "cangjie" debug type.
 */
export class CangjieDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(
		folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor
			if (editor && editor.document.languageId === "cangjie") {
				config.type = "cangjie"
				config.name = t("info.cangjie_lsp.debug_cangjie_program")
				config.request = "launch"
				config.program = "${workspaceFolder}/target/output"
				config.cwd = "${workspaceFolder}"
				config.preLaunchTask = "cjpm: build"
			}
		}

		if (!config.program) {
			return vscode.window
				.showInformationMessage(t("info.cangjie_lsp.configure_program_path"))
				.then(() => undefined)
		}

		const ws = folder?.uri.fsPath
		const programStr = String(config.program)
		const resolvedOnDisk = ws ? substituteWorkspaceFolder(programStr, ws) : programStr

		if (ws && !fs.existsSync(resolvedOnDisk)) {
			const found = findCangjieExecutableInTarget(ws)
			if (found) {
				const rel = path.relative(ws, found).replace(/\\/g, "/")
				config.program = "${workspaceFolder}/" + rel
			} else {
				const useDebugBuildBtn = t("buttons.cangjie_lsp.use_cjpm_build_debug")
				const stillLaunchBtn = t("buttons.cangjie_lsp.still_launch")
				return vscode.window
					.showWarningMessage(
						t("warnings.cangjie_lsp.executable_not_found_in_target"),
						useDebugBuildBtn,
						stillLaunchBtn,
					)
					.then((choice) => {
						if (choice === undefined) return undefined
						if (choice === useDebugBuildBtn) {
							config.preLaunchTask = "cjpm: build (debug)"
						}
						config.cwd = config.cwd || folder?.uri.fsPath || "${workspaceFolder}"
						return config
					})
			}
		}

		config.cwd = config.cwd || folder?.uri.fsPath || "${workspaceFolder}"

		return config
	}

	provideDebugConfigurations(
		_folder: vscode.WorkspaceFolder | undefined,
		_token?: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DebugConfiguration[]> {
		return [
			{
				type: "cangjie",
				request: "launch",
				name: t("info.cangjie_lsp.debug_cangjie_program"),
				program: "${workspaceFolder}/target/output",
				args: [],
				cwd: "${workspaceFolder}",
				preLaunchTask: "cjpm: build",
			},
			{
				type: "cangjie",
				request: "launch",
				name: t("info.cangjie_lsp.debug_cangjie_test"),
				program: "${workspaceFolder}/target/output",
				args: ["--test"],
				cwd: "${workspaceFolder}",
				preLaunchTask: "cjpm: build",
			},
		]
	}
}
