import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import {
	LanguageClient,
	LanguageClientOptions,
	Middleware,
	ServerOptions,
	TransportKind,
} from "vscode-languageclient/node"
import { Package } from "../../shared/package"
import { getErrorMessage } from "../../shared/error-utils"

const CANGJIE_LANGUAGE_ID = "cangjie"
const LSP_SERVER_NAME = "Cangjie Language Server"

// ---------------------------------------------------------------------------
// Middleware helpers: debounce high-frequency LSP requests
// ---------------------------------------------------------------------------

function debounceMiddleware<T>(delayMs: number): (
	next: () => vscode.ProviderResult<T>,
) => Thenable<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	let pending: { resolve: (v: T) => void; reject: (e: unknown) => void } | undefined
	let lastResult: T | undefined

	return (next) => {
		if (timer) {
			clearTimeout(timer)
			pending?.resolve(lastResult as T)
		}
		return new Promise<T>((resolve, reject) => {
			pending = { resolve, reject }
			timer = setTimeout(() => {
				timer = undefined
				pending = undefined
				Promise.resolve(next()).then((result) => {
					lastResult = result as T
					resolve(result as T)
				}, reject)
			}, delayMs)
		})
	}
}

function buildMiddleware(): Middleware {
	const hoverDebounce = debounceMiddleware<vscode.Hover | null | undefined>(100)
	const completionDebounce = debounceMiddleware<vscode.CompletionItem[] | vscode.CompletionList | null | undefined>(150)

	return {
		provideHover: (document, position, token, next) =>
			hoverDebounce(() => next(document, position, token)),
		provideCompletionItem: (document, position, context, token, next) =>
			completionDebounce(() => next(document, position, context, token)),
	}
}

// ---------------------------------------------------------------------------
// cjpm.toml package name reader & false-positive diagnostic filter
// ---------------------------------------------------------------------------

const CJPM_PKG_NAME_RE = /^\s*name\s*=\s*"([^"]+)"/m

function readCjpmPackageName(projectRoot: string): string | undefined {
	try {
		const tomlPath = path.join(projectRoot, "cjpm.toml")
		const content = fs.readFileSync(tomlPath, "utf-8")

		const pkgIdx = content.indexOf("[package]")
		if (pkgIdx === -1) return undefined

		const nextSectionIdx = content.indexOf("\n[", pkgIdx + 1)
		const pkgSection = nextSectionIdx === -1
			? content.slice(pkgIdx)
			: content.slice(pkgIdx, nextSectionIdx)

		const match = pkgSection.match(CJPM_PKG_NAME_RE)
		return match ? match[1] : undefined
	} catch {
		return undefined
	}
}

const PKG_SUPPOSED_RE = /package\s+name\s+supposed\s+to\s+be\s+'([^']+)'/i

function filterFalsePackageDiagnostics(
	diagnostics: vscode.Diagnostic[],
	realPackageName: string | undefined,
	uri: vscode.Uri,
): vscode.Diagnostic[] {
	let documentText: string | undefined = undefined

	return diagnostics.filter((diag) => {
		const match = diag.message.match(PKG_SUPPOSED_RE)
		if (!match) return true

		const lspExpected = match[1]

		if (realPackageName && lspExpected === "default" && realPackageName !== "default") {
			return false
		}

		if (documentText === undefined) {
			const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
			documentText = doc ? doc.getText() : ""
		}

		if (documentText) {
			// Escape regex characters in the expected package name just in case
			const escapedExpected = lspExpected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
			
			// 1. If document already correctly declares EXACTLY what LSP expects (LSP is out of sync)
			const actualPackageDecl = new RegExp(`^\\s*package\\s+${escapedExpected}\\s*(//.*)?$`, 'm')
			if (actualPackageDecl.test(documentText)) {
				return false // The document already correctly declares this package. False positive!
			}

			// 2. If LSP expects 'default' but document has an explicit package declaration (LSP failed to infer package context)
			if (lspExpected === "default" && realPackageName !== "default") {
				const anyPackageDecl = /^\s*package\s+[a-zA-Z0-9_.]+\s*(?:\/\/.*)?$/m
				if (anyPackageDecl.test(documentText)) {
					return false // False positive, user explicitly named their package, ignore LSP's default fallback
				}
			}
		}

		return true
	})
}

interface CangjieLspConfig {
	enabled: boolean
	serverPath: string
	enableLog: boolean
	logPath: string
	disableAutoImport: boolean
}

function getConfig(): CangjieLspConfig {
	const config = vscode.workspace.getConfiguration(Package.name)
	return {
		enabled: config.get<boolean>("cangjieLsp.enabled", true),
		serverPath: config.get<string>("cangjieLsp.serverPath", ""),
		enableLog: config.get<boolean>("cangjieLsp.enableLog", false),
		logPath: config.get<string>("cangjieLsp.logPath", ""),
		disableAutoImport: config.get<boolean>("cangjieLsp.disableAutoImport", false),
	}
}

/**
 * Detect CANGJIE_HOME from environment, configured path, or well-known locations.
 */
export function detectCangjieHome(serverPath?: string): string | undefined {
	if (process.env.CANGJIE_HOME && fs.existsSync(process.env.CANGJIE_HOME)) {
		return process.env.CANGJIE_HOME
	}

	if (serverPath) {
		const resolved = path.resolve(serverPath)
		const binDir = path.dirname(resolved)
		const parentDir = path.dirname(binDir)
		if (fs.existsSync(path.join(parentDir, "runtime")) || fs.existsSync(path.join(parentDir, "lib"))) {
			return parentDir
		}
		const grandParent = path.dirname(parentDir)
		if (fs.existsSync(path.join(grandParent, "runtime")) || fs.existsSync(path.join(grandParent, "lib"))) {
			return grandParent
		}
	}

	const wellKnownPaths = process.platform === "win32"
		? ["D:\\cangjie", "C:\\cangjie", path.join(process.env.LOCALAPPDATA || "", "cangjie")]
		: ["/usr/local/cangjie", path.join(process.env.HOME || "", ".cangjie")]

	for (const p of wellKnownPaths) {
		if (p && fs.existsSync(path.join(p, "bin"))) {
			return p
		}
	}

	return undefined
}

/**
 * Build the environment variables the LSP server needs.
 * Mirrors the logic in envsetup.ps1 / envsetup.sh.
 */
function buildServerEnv(cangjieHome: string): Record<string, string> {
	const env = { ...process.env } as Record<string, string>
	env["CANGJIE_HOME"] = cangjieHome

	const sep = process.platform === "win32" ? ";" : ":"
	const extraPaths: string[] = []

	if (process.platform === "win32") {
		extraPaths.push(path.join(cangjieHome, "runtime", "lib", "windows_x86_64_llvm"))
		extraPaths.push(path.join(cangjieHome, "lib", "windows_x86_64_llvm"))
	} else {
		extraPaths.push(path.join(cangjieHome, "runtime", "lib", "linux_x86_64_llvm"))
		extraPaths.push(path.join(cangjieHome, "lib", "linux_x86_64_llvm"))
	}
	extraPaths.push(path.join(cangjieHome, "bin"))
	extraPaths.push(path.join(cangjieHome, "tools", "bin"))
	extraPaths.push(path.join(cangjieHome, "tools", "lib"))

	const existing = env["PATH"] || env["Path"] || ""
	const pathKey = process.platform === "win32" ? "Path" : "PATH"
	env[pathKey] = extraPaths.filter((p) => fs.existsSync(p)).join(sep) + sep + existing

	if (process.platform !== "win32") {
		const ldPaths = extraPaths.filter((p) => fs.existsSync(p))
		const existingLd = env["LD_LIBRARY_PATH"] || ""
		if (ldPaths.length > 0) {
			env["LD_LIBRARY_PATH"] = ldPaths.join(sep) + (existingLd ? sep + existingLd : "")
		}
	}

	return env
}

/**
 * Try to locate the LSPServer executable by checking:
 * 1. User-configured path
 * 2. CANGJIE_HOME environment variable
 * 3. Well-known install locations
 * 4. System PATH
 */
function resolveServerPath(configuredPath: string, cangjieHome?: string): string | undefined {
	if (configuredPath) {
		const resolved = path.resolve(configuredPath)
		if (fs.existsSync(resolved)) {
			return resolved
		}
		return undefined
	}

	if (cangjieHome) {
		const candidates = [
			path.join(cangjieHome, "bin", "LSPServer.exe"),
			path.join(cangjieHome, "bin", "LSPServer"),
			path.join(cangjieHome, "tools", "bin", "LSPServer.exe"),
			path.join(cangjieHome, "tools", "bin", "LSPServer"),
		]
		for (const candidate of candidates) {
			if (fs.existsSync(candidate)) {
				return candidate
			}
		}
	}

	const exeName = process.platform === "win32" ? "LSPServer.exe" : "LSPServer"
	return exeName
}

function buildServerArgs(config: CangjieLspConfig): string[] {
	const args: string[] = []
	if (config.enableLog) {
		args.push("--enable-log=true")
		args.push("-V")
	}
	if (config.logPath) {
		args.push(`--log-path=${config.logPath}`)
	}
	if (config.disableAutoImport) {
		args.push("--disableAutoImport")
	}
	return args
}

export type CangjieLspState = "idle" | "starting" | "running" | "warning" | "error" | "stopped"

export type CangjieLspStateListener = (state: CangjieLspState, message?: string) => void

const MAX_AUTO_RESTARTS = 3
const RESTART_DELAYS_MS = [2_000, 5_000, 10_000]

function normalizeCwdKey(cwd: string): string {
	return path.normalize(cwd)
}

function isFsPathUnderRoot(filePath: string, root: string): boolean {
	const f = path.normalize(filePath)
	const r = path.normalize(root)
	const sep = path.sep
	if (process.platform === "win32") {
		const fl = f.toLowerCase()
		const rl = r.toLowerCase()
		return fl === rl || fl.startsWith(rl + sep) || fl.startsWith(rl + "/")
	}
	return f === r || f.startsWith(r + sep)
}

/** vscode-languageclient 9.x exposes client-owned diagnostics; typings may omit it. */
function getLanguageClientDiagnostics(client: LanguageClient): vscode.DiagnosticCollection | undefined {
	const c = client as unknown as { diagnostics?: vscode.DiagnosticCollection }
	return c.diagnostics
}

export class CangjieLspClient {
	private client: LanguageClient | undefined
	private readonly _lspOutputChannel: vscode.OutputChannel
	private configChangeDisposable: vscode.Disposable | undefined
	private lazyStartDisposable: vscode.Disposable | undefined
	/** When LSP is disabled: defer formatter/linter/compile-guard until first .cj open. */
	private lazyCangjieServicesDisposable: vscode.Disposable | undefined
	private clientStateDisposable: vscode.Disposable | undefined
	private _state: CangjieLspState = "idle"
	private stateListeners: CangjieLspStateListener[] = []
	private onCangjieActivatedCallback: (() => void) | undefined
	private autoRestartCount = 0
	private restartTimer: ReturnType<typeof setTimeout> | undefined
	/** Serialize config-driven stop→start so rapid settings changes do not overlap. */
	private configRestartChain: Promise<void> = Promise.resolve()
	private firstCompletionLogged = false
	private firstHoverLogged = false
	/** After cjpm build success: drop stale LSP Error diagnostics for this root (ms since epoch). */
	private lastCjpmSuccessAtMsByCwd = new Map<string, number>()

	constructor(private readonly extensionOutputChannel: vscode.OutputChannel) {
		this._lspOutputChannel = vscode.window.createOutputChannel(LSP_SERVER_NAME)
	}

	get lspOutputChannel(): vscode.OutputChannel {
		return this._lspOutputChannel
	}

	get state(): CangjieLspState {
		return this._state
	}

	onStateChange(listener: CangjieLspStateListener): vscode.Disposable {
		this.stateListeners.push(listener)
		return { dispose: () => { this.stateListeners = this.stateListeners.filter((l) => l !== listener) } }
	}

	/**
	 * Register a callback invoked once when the first .cj file is opened,
	 * allowing other Cangjie services (formatter, linter) to defer initialization.
	 */
	onCangjieActivated(callback: () => void): void {
		if (this._state === "running" || this._state === "starting") {
			callback()
		} else {
			this.onCangjieActivatedCallback = callback
		}
	}

	private fireOnCangjieActivatedOnce(): void {
		const cb = this.onCangjieActivatedCallback
		this.onCangjieActivatedCallback = undefined
		cb?.()
	}

	/**
	 * LSP is off: still trigger the one-shot activation callback when the user opens a .cj file
	 * (or immediately if one is already open) so cjfmt/cjlint/compile-guard wire up.
	 */
	private scheduleCangjieServicesWithoutLsp(): void {
		this.lazyCangjieServicesDisposable?.dispose()
		this.lazyCangjieServicesDisposable = undefined

		const hasOpenCangjieFile = vscode.workspace.textDocuments.some(
			(doc) => doc.languageId === CANGJIE_LANGUAGE_ID || doc.fileName.endsWith(".cj"),
		)

		if (hasOpenCangjieFile) {
			this.fireOnCangjieActivatedOnce()
		} else {
			this.lazyCangjieServicesDisposable = vscode.workspace.onDidOpenTextDocument((doc) => {
				if (doc.languageId === CANGJIE_LANGUAGE_ID || doc.fileName.endsWith(".cj")) {
					this.lazyCangjieServicesDisposable?.dispose()
					this.lazyCangjieServicesDisposable = undefined
					this.fireOnCangjieActivatedOnce()
				}
			})
		}
	}

	private attachCangjieLspConfigListener(): void {
		this.configChangeDisposable?.dispose()
		this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration(`${Package.name}.cangjieLsp`)) {
				return
			}
			this.extensionOutputChannel.appendLine("[CangjieLSP] Configuration changed, restarting server...")
			this.configRestartChain = this.configRestartChain
				.catch(() => { /* keep chain alive after error */ })
				.then(async () => {
					await this.stop()
					await this.start()
				})
				.catch((err) => {
					const msg = getErrorMessage(err)
					this.extensionOutputChannel.appendLine(`[CangjieLSP] Config restart failed: ${msg}`)
				})
		})
	}

	private setState(state: CangjieLspState, message?: string): void {
		this._state = state
		for (const listener of this.stateListeners) {
			listener(state, message)
		}
	}

	/**
	 * Lazy start: if no .cj file is currently open, defer server startup
	 * until the user opens one. This avoids spawning the LSP process for
	 * workspaces that don't contain Cangjie code.
	 */
	async start(): Promise<void> {
		const config = getConfig()

		if (!config.enabled) {
			this.extensionOutputChannel.appendLine("[CangjieLSP] Cangjie LSP is disabled by configuration.")
			this.setState("stopped")
			this.scheduleCangjieServicesWithoutLsp()
			this.attachCangjieLspConfigListener()
			return
		}

		const hasOpenCangjieFile = vscode.workspace.textDocuments.some(
			(doc) => doc.languageId === CANGJIE_LANGUAGE_ID || doc.fileName.endsWith(".cj"),
		)

		if (hasOpenCangjieFile) {
			await this.doStart(config)
		} else {
			this.extensionOutputChannel.appendLine("[CangjieLSP] No .cj files open — deferring LSP startup.")
			this.setState("idle")
			this.lazyStartDisposable = vscode.workspace.onDidOpenTextDocument(async (doc) => {
				if (doc.languageId === CANGJIE_LANGUAGE_ID || doc.fileName.endsWith(".cj")) {
					this.lazyStartDisposable?.dispose()
					this.lazyStartDisposable = undefined
					await this.doStart(getConfig())
				}
			})
		}

		this.attachCangjieLspConfigListener()
	}

	private findCjpmRoot(): string | undefined {
		const folders = vscode.workspace.workspaceFolders
		if (!folders) return undefined

		for (const folder of folders) {
			const tomlPath = path.join(folder.uri.fsPath, "cjpm.toml")
			if (fs.existsSync(tomlPath)) return folder.uri.fsPath
		}
		return undefined
	}

	private async doStart(config: CangjieLspConfig): Promise<void> {
		this.setState("starting")

		const cangjieHome = detectCangjieHome(config.serverPath)
		this.extensionOutputChannel.appendLine(`[CangjieLSP] Detected CANGJIE_HOME: ${cangjieHome || "(not found)"}`)

		const serverExecutable = resolveServerPath(config.serverPath, cangjieHome)
		if (!serverExecutable) {
			const msg = config.serverPath
				? `Cangjie LSP server not found at configured path: ${config.serverPath}`
				: "Cangjie LSP server not found. Set 'njust-ai-cj.cangjieLsp.serverPath' or the CANGJIE_HOME environment variable."
			vscode.window.showWarningMessage(msg)
			this.extensionOutputChannel.appendLine(`[CangjieLSP] ${msg}`)
			this.setState("warning", msg)
			// Still wire cjfmt / cjlint / compile-guard when the language server binary is missing.
			this.fireOnCangjieActivatedOnce()
			return
		}

		this.extensionOutputChannel.appendLine(`[CangjieLSP] Starting server: ${serverExecutable}`)

		const args = buildServerArgs(config)
		const serverEnv = cangjieHome ? buildServerEnv(cangjieHome) : { ...process.env }

		if (cangjieHome) {
			this.extensionOutputChannel.appendLine(`[CangjieLSP] Server environment: CANGJIE_HOME=${cangjieHome}`)
		} else {
			this.extensionOutputChannel.appendLine(
				"[CangjieLSP] WARNING: CANGJIE_HOME not detected. The LSP server may fail to start. " +
				"Please set the CANGJIE_HOME environment variable or run envsetup.ps1 from the Cangjie SDK."
			)
		}

		const cjpmRoot = this.findCjpmRoot()
		const serverCwd = cjpmRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

		const serverOptions: ServerOptions = {
			command: serverExecutable,
			args,
			transport: TransportKind.stdio,
			options: {
				env: serverEnv as NodeJS.ProcessEnv,
				cwd: serverCwd,
			},
		}

		if (cjpmRoot) {
			this.extensionOutputChannel.appendLine(`[CangjieLSP] Project root (cjpm.toml): ${cjpmRoot}`)
		}

		const realPackageName = cjpmRoot ? readCjpmPackageName(cjpmRoot) : undefined
		if (realPackageName) {
			this.extensionOutputChannel.appendLine(`[CangjieLSP] Root package name from cjpm.toml: "${realPackageName}"`)
		}

		const baseMiddleware = buildMiddleware()
		const clientOptions: LanguageClientOptions = {
			documentSelector: [{ scheme: "file", language: CANGJIE_LANGUAGE_ID }],
			outputChannel: this._lspOutputChannel,
			workspaceFolder: cjpmRoot
				? { uri: vscode.Uri.file(cjpmRoot), name: path.basename(cjpmRoot), index: 0 }
				: undefined,
			initializationOptions: cjpmRoot ? { projectRoot: cjpmRoot } : undefined,
			synchronize: {
				fileEvents: vscode.workspace.createFileSystemWatcher("**/*.cj"),
			},
			middleware: {
				handleDiagnostics: (uri, diagnostics, next) => {
					diagnostics = filterFalsePackageDiagnostics(diagnostics, realPackageName, uri)
					diagnostics = this.applyLspErrorSuppressAfterCjpmSuccess(uri, diagnostics)
					next(uri, diagnostics)
				},
				provideCompletionItem: (document, position, context, token, next) => {
					const t0 = Date.now()
					const result = baseMiddleware.provideCompletionItem!(document, position, context, token, next)
					if (!this.firstCompletionLogged && result) {
						Promise.resolve(result).then(() => {
							if (!this.firstCompletionLogged) {
								this.firstCompletionLogged = true
								this.extensionOutputChannel.appendLine(`[Perf] First completion response in ${Date.now() - t0}ms`)
							}
						}).catch(() => { /* best-effort perf logging */ })
					}
					return result
				},
				provideHover: (document, position, token, next) => {
					const t0 = Date.now()
					const result = baseMiddleware.provideHover!(document, position, token, next)
					if (!this.firstHoverLogged && result) {
						Promise.resolve(result).then(() => {
							if (!this.firstHoverLogged) {
								this.firstHoverLogged = true
								this.extensionOutputChannel.appendLine(`[Perf] First hover response in ${Date.now() - t0}ms`)
							}
						}).catch(() => { /* best-effort perf logging */ })
					}
					return result
				},
			},
		}

		this.client = new LanguageClient(
			"cangjieLsp",
			LSP_SERVER_NAME,
			serverOptions,
			clientOptions,
		)

		// Register before start() so a crash/stop between start resolving and this listener cannot be missed.
		this.clientStateDisposable?.dispose()
		this.clientStateDisposable = this.client.onDidChangeState((e) => {
			if (e.newState === 1 /* Stopped */ && (this._state === "running" || this._state === "starting")) {
				this.extensionOutputChannel.appendLine("[CangjieLSP] Server process stopped unexpectedly.")
				this.setState("error", "Server stopped unexpectedly")
				this.client = undefined
				this.scheduleAutoRestart()
			}
		})

		const startTime = Date.now()
		try {
			await this.client.start()
			const elapsed = Date.now() - startTime
			this.extensionOutputChannel.appendLine(`[Perf] LSP server started in ${elapsed}ms`)
			this.extensionOutputChannel.appendLine("[CangjieLSP] Server started successfully.")
			this.setState("running")
			this.autoRestartCount = 0
			this.fireOnCangjieActivatedOnce()
		} catch (error) {
			const message = getErrorMessage(error)
			this.extensionOutputChannel.appendLine(`[CangjieLSP] Failed to start server: ${message}`)
			this.setState("error", message)
			if (message.includes("initialize fail") || message.includes("system api")) {
				vscode.window.showErrorMessage(
					`Cangjie LSP 启动失败: ${message}。请确认已运行 Cangjie SDK 的 envsetup 脚本，或在设置中配置正确的 CANGJIE_HOME 路径。`,
					"打开设置"
				).then((choice) => {
					if (choice === "打开设置") {
						vscode.commands.executeCommand("workbench.action.openSettings", `${Package.name}.cangjieLsp`)
					}
				})
			} else {
				vscode.window.showErrorMessage(`Failed to start Cangjie Language Server: ${message}`)
			}
			// Allow formatter, linter, and compile-guard to work without a running LSP.
			this.fireOnCangjieActivatedOnce()
		}
	}

	private scheduleAutoRestart(): void {
		if (this.autoRestartCount >= MAX_AUTO_RESTARTS) {
			this.extensionOutputChannel.appendLine(
				`[CangjieLSP] Auto-restart limit reached (${MAX_AUTO_RESTARTS}). Use "Cangjie: Restart Language Server" to retry manually.`,
			)
			vscode.window.showErrorMessage(
				`仓颉语言服务连续崩溃 ${MAX_AUTO_RESTARTS} 次，已停止自动重启。请检查 SDK 配置或手动重启。`,
				"手动重启",
			).then((choice) => {
				if (choice === "手动重启") {
					this.autoRestartCount = 0
					void this.restart()
				}
			})
			return
		}

		const delayMs = RESTART_DELAYS_MS[Math.min(this.autoRestartCount, RESTART_DELAYS_MS.length - 1)]
		this.autoRestartCount++
		this.extensionOutputChannel.appendLine(
			`[CangjieLSP] Auto-restarting in ${delayMs / 1000}s (attempt ${this.autoRestartCount}/${MAX_AUTO_RESTARTS})…`,
		)

		this.restartTimer = setTimeout(async () => {
			this.restartTimer = undefined
			await this.stop()
			void this.doStart(getConfig())
		}, delayMs)
	}

	async stop(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer)
			this.restartTimer = undefined
		}
		this.configChangeDisposable?.dispose()
		this.configChangeDisposable = undefined
		this.lazyStartDisposable?.dispose()
		this.lazyStartDisposable = undefined
		this.lazyCangjieServicesDisposable?.dispose()
		this.lazyCangjieServicesDisposable = undefined
		this.clientStateDisposable?.dispose()
		this.clientStateDisposable = undefined

		if (this.client) {
			try {
				if (this.client.isRunning()) {
					await this.client.stop()
				}
			} catch (error) {
				const message = getErrorMessage(error)
				this.extensionOutputChannel.appendLine(`[CangjieLSP] Error stopping server: ${message}`)
			}
			this.client = undefined
		}
		this.setState("stopped")
	}

	async restart(): Promise<void> {
		this.autoRestartCount = 0
		await this.stop()
		await this.start()
	}

	async dispose(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer)
			this.restartTimer = undefined
		}
		this.configChangeDisposable?.dispose()
		this.configChangeDisposable = undefined
		this.lazyStartDisposable?.dispose()
		this.lazyStartDisposable = undefined
		this.lazyCangjieServicesDisposable?.dispose()
		this.lazyCangjieServicesDisposable = undefined
		this.clientStateDisposable?.dispose()
		this.clientStateDisposable = undefined

		if (this.client?.isRunning()) {
			try {
				await Promise.race([
					this.client.stop(),
					new Promise((_, reject) => setTimeout(() => reject(new Error("LSP stop timeout")), 5_000)),
				])
			} catch {
				// Process cleaned up by VS Code on extension deactivation
			}
		}
		this.client = undefined

		try {
			this._lspOutputChannel.dispose()
		} catch {
			// already disposed
		}
	}

	isRunning(): boolean {
		return this.client?.isRunning() ?? false
	}

	/**
	 * Record a successful `cjpm build` for `cwd` so optional middleware can suppress stale LSP errors briefly.
	 */
	markCjpmBuildSuccess(cwd: string): void {
		if (!cwd) return
		this.lastCjpmSuccessAtMsByCwd.set(normalizeCwdKey(cwd), Date.now())
	}

	/**
	 * Remove LSP-published diagnostics (stale analysis after cjpm reports success).
	 * When `cwd` is set, only touches `.cj` files under that cjpm root (open buffers sync; workspace scan async).
	 */
	clearPublishedDiagnostics(opts?: { cwd?: string }): void {
		if (!this.client?.isRunning()) return
		const coll = getLanguageClientDiagnostics(this.client)
		if (!coll) return
		if (!opts?.cwd) {
			coll.clear()
			this.extensionOutputChannel.appendLine("[CangjieLSP] Cleared all LSP diagnostics after cjpm success (no cwd).")
			return
		}
		const root = normalizeCwdKey(opts.cwd)
		let n = 0
		for (const doc of vscode.workspace.textDocuments) {
			if (!doc.uri.fsPath.endsWith(".cj")) continue
			if (!isFsPathUnderRoot(doc.uri.fsPath, root)) continue
			coll.delete(doc.uri)
			n++
		}
		void this.deleteClosedCjFilesFromLspDiagnostics(root, coll).then((extra) => {
			if (n + extra > 0) {
				this.extensionOutputChannel.appendLine(
					`[CangjieLSP] Cleared LSP diagnostics under ${root} (${n} open + ${extra} closed .cj) after cjpm success.`,
				)
			}
		})
	}

	private async deleteClosedCjFilesFromLspDiagnostics(
		root: string,
		coll: vscode.DiagnosticCollection,
	): Promise<number> {
		let extra = 0
		try {
			const uris = await vscode.workspace.findFiles(
				new vscode.RelativePattern(root, "**/*.cj"),
				"**/target/**",
				500,
			)
			const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()))
			for (const uri of uris) {
				if (!isFsPathUnderRoot(uri.fsPath, root)) continue
				if (open.has(uri.toString())) continue
				coll.delete(uri)
				extra++
			}
		} catch {
			/* ignore */
		}
		return extra
	}

	private findCjpmRootContainingFile(filePath: string): string | undefined {
		let dir = path.dirname(filePath)
		for (let i = 0; i < 40; i++) {
			if (fs.existsSync(path.join(dir, "cjpm.toml"))) return dir
			const parent = path.dirname(dir)
			if (parent === dir) break
			dir = parent
		}
		return undefined
	}

	private suppressLspErrorsAfterCjpmSuccessMs(): number {
		const v = vscode.workspace.getConfiguration(Package.name).get<number>("cangjieLsp.suppressLspErrorsAfterCjpmSuccessMs", 0)
		return typeof v === "number" && v > 0 ? v : 0
	}

	private applyLspErrorSuppressAfterCjpmSuccess(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
		const windowMs = this.suppressLspErrorsAfterCjpmSuccessMs()
		if (windowMs <= 0 || diagnostics.length === 0) return diagnostics
		const proj = this.findCjpmRootContainingFile(uri.fsPath)
		if (!proj) return diagnostics
		const t0 = this.lastCjpmSuccessAtMsByCwd.get(normalizeCwdKey(proj))
		if (t0 === undefined) return diagnostics
		if (Date.now() - t0 > windowMs) return diagnostics
		const filtered = diagnostics.filter((d) => d.severity !== vscode.DiagnosticSeverity.Error)
		if (filtered.length !== diagnostics.length && getConfig().enableLog) {
			this.extensionOutputChannel.appendLine(
				`[CangjieLSP] Suppressed ${diagnostics.length - filtered.length} stale LSP error(s) (${uri.fsPath}) within ${windowMs}ms of cjpm success.`,
			)
		}
		return filtered
	}
}
