import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { createHash } from "crypto"
import { execFile } from "child_process"
import { promisify } from "util"
import { Package } from "../../shared/package"
import { resolveCangjieToolPath, buildCangjieToolEnv } from "./cangjieToolUtils"
import { invalidateCangjieL3ContextCache, recordLearnedFix, recordLearnedFailure } from "../../core/prompts/sections/cangjie-context"
import { getCjpmTreeSummaryForPrompt } from "./cjpmTreeForPrompt"
import { recordCompileHistoryEvent } from "./cangjieCompileHistory"
import { analyzeCompileOutput, formatAnalysisSummary, getFixDirectiveForLearning, normalizeErrorPattern } from "./CangjieErrorAnalyzer"
import type { CangjieMetricsCollector } from "./CangjieMetricsCollector"

const execFileAsync = promisify(execFile)

const COMPILE_TIMEOUT_MS = 60_000
const FORMAT_TIMEOUT_MS = 15_000

/** Prefer first line + last lines so location hints at the end survive UI truncation. */
function truncateCompileDiagnosticMessage(raw: string, maxLen: number): string {
	const normalized = raw.replace(/\s+/g, " ").trim()
	if (normalized.length <= maxLen) return normalized

	const lines = raw
		.split(/\n/)
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length > 0)
	if (lines.length <= 4) {
		return normalized.slice(0, maxLen)
	}
	const head = lines[0]
	const tail = lines.slice(-3).join(" ")
	let combined = `${head} … ${tail}`.replace(/\s+/g, " ").trim()
	if (combined.length > maxLen) {
		combined = combined.slice(0, Math.max(0, maxLen - 1)) + "…"
	}
	return combined
}

// re-export CjcErrorPattern regex used by enhanceCjcErrorOutput
const CJC_ERROR_LOCATION_RE = /==>\s+(.+?):(\d+):(\d+):/g

export interface CompileResult {
	success: boolean
	output: string
	errorCount: number
	errorLocations: Array<{ file: string; line: number; col: number }>
	incremental?: boolean
}

export interface FormatResult {
	formatted: boolean
	output: string
}

/** Fired when an auto-build starts / finishes (save pipeline or explicit `compile()`). */
export interface CompileLifecycleEvent {
	status: "start" | "end"
	cwd: string
	/** Present when status === "end" */
	success?: boolean
	durationMs?: number
	incremental?: boolean
	errorCount?: number
	/** Last known full-build duration (ms), for incremental vs full comparison in UI */
	lastFullBuildMs?: number | null
}

/**
 * Compile guard – provides post-write hooks for .cj files:
 *  1. Auto-compile via `cjpm build` (incremental by default) after file save
 *  2. Auto-format via `cjfmt -f` before/after save
 *  3. Record resolved errors to learned-fixes
 */
export class CangjieCompileGuard implements vscode.Disposable {
	private disposables: vscode.Disposable[] = []
	private lastErrors = new Map<string, string>()
	private lastCjpmTomlHash: string | undefined
	/** `-i` last failed for this workspace session — use full `cjpm build` until {@link fullBuildCountSinceIncrementalFailure} reaches retry threshold. */
	private incrementalAvailable = true
	private fullBuildCountSinceIncrementalFailure = 0
	private readonly INCREMENTAL_RETRY_AFTER_FULL_BUILDS = 2
	private lastFullBuildDurationMs: number | null = null
	private readonly _onCompile = new vscode.EventEmitter<CompileLifecycleEvent>()
	readonly onCompile = this._onCompile.event
	/** Serialize `cjpm build` per project root — rapid saves must not run parallel builds. */
	private compileTailByCwd = new Map<string, Promise<void>>()
	/** Avoid reading/hashing cjpm.toml twice in one compile decision chain. */
	private tomlHashCache: { cwd: string; hash: string | undefined } | null = null
	/** Merge rapid saves into a single `cjpm build` per cwd. */
	private compileDebounceByCwd = new Map<string, ReturnType<typeof setTimeout>>()
	private lintReportUriByCwd = new Map<string, vscode.Uri>()
	private readonly COMPILE_DEBOUNCE_MS = 500

	constructor(
		private readonly outputChannel: vscode.OutputChannel,
		private metricsCollector: CangjieMetricsCollector | undefined = undefined,
		private readonly compileDiagnostics: vscode.DiagnosticCollection | undefined = undefined,
		private readonly onSuccessfulBuild?: (ctx: { cwd: string; docUri?: vscode.Uri }) => void,
		/** Fired after cjpm compile diagnostics are cleared for a successful build (any caller of publishCompileDiagnostics). */
		private readonly onCjpmBuildSucceededForLsp?: (ctx: { cwd: string }) => void,
	) {}

	setMetricsCollector(collector: CangjieMetricsCollector | undefined): void {
		this.metricsCollector = collector
	}

	/**
	 * Register a post-save pipeline for .cj files (Phases 3.1, 3.2, 3.3):
	 *   1. Auto-format with cjfmt (Phase 3.2)
	 *   2. Auto-compile with cjpm build (Phase 3.1)
	 *   3. Report cjlint diagnostic count (Phase 3.3)
	 *   4. Record resolved error→fix patterns (Phase 1.3)
	 */
	registerSaveHook(): void {
		const watcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
			if (doc.languageId !== "cangjie" && !doc.fileName.endsWith(".cj")) return

			const cwd = this.findCjpmRoot(doc.uri)
			if (!cwd) return

			// Step 1: Auto-format with cjfmt (Phase 3.2)
			const formatResult = await this.formatFile(doc.fileName)
			if (formatResult.formatted) {
				this.outputChannel.appendLine(
					`[CompileGuard] 🎨 cjfmt formatted ${path.basename(doc.fileName)}`,
				)
			}

			this.lintReportUriByCwd.set(cwd, doc.uri)
			const prev = this.compileDebounceByCwd.get(cwd)
			if (prev) clearTimeout(prev)
			const t = setTimeout(() => {
				this.compileDebounceByCwd.delete(cwd)
				this.runDebouncedPostSavePipeline(cwd).catch((err) => {
				this.outputChannel.appendLine(
					`[CompileGuard] Unhandled error in post-save pipeline: ` +
					`${err instanceof Error ? err.message : String(err)}`,
				)
			})
			}, this.COMPILE_DEBOUNCE_MS)
			this.compileDebounceByCwd.set(cwd, t)
		})
		this.disposables.push(watcher)
	}

	private async runDebouncedPostSavePipeline(cwd: string): Promise<void> {
		const docUri = this.lintReportUriByCwd.get(cwd)
		const savedLabel = docUri ? path.basename(docUri.fsPath) : path.basename(cwd)

		const beforeErrors = new Map(this.lastErrors)
		const result = await this.compile(cwd)

		const buildMode = result.incremental ? "incremental" : "full"
		if (result.success) {
			for (const [errorKey, errorMsg] of beforeErrors) {
				if (!this.lastErrors.has(errorKey)) {
					const fix = getFixDirectiveForLearning(errorMsg) ?? this.getSuggestionForError(errorMsg)
					if (fix) {
						recordLearnedFix(cwd, errorMsg, fix)
						this.outputChannel.appendLine(
							`[CompileGuard] 📚 Learned fix recorded for: ${errorMsg.slice(0, 60)}…`,
						)
					}
				}
			}
			this.outputChannel.appendLine(`[CompileGuard] ✅ Build passed (${buildMode}) after save burst (${savedLabel})`)
			this.onSuccessfulBuild?.({ cwd, docUri: docUri ?? undefined })
			this.onCjpmBuildSucceededForLsp?.({ cwd })
		} else {
			this.outputChannel.appendLine(
				`[CompileGuard] ❌ Build failed (${buildMode}, ${result.errorCount} error(s)) after save burst (${savedLabel})`,
			)
			const analyses = analyzeCompileOutput(result.output, result.errorLocations)
			const summary = formatAnalysisSummary(analyses)
			if (summary) {
				this.outputChannel.appendLine(summary)
			}
			for (const errMsg of this.lastErrors.values()) {
				recordLearnedFailure(cwd, errMsg)
			}
		}

		if (docUri) {
			const lintDiagCount = this.countCjlintDiagnostics(docUri)
			if (lintDiagCount > 0) {
				this.outputChannel.appendLine(
					`[CompileGuard] ⚠️  ${lintDiagCount} cjlint diagnostic(s) on ${path.basename(docUri.fsPath)} — run cjpm build -l to review`,
				)
			}
		}
	}

	/**
	 * Count active cjlint diagnostics for a file (Phase 3.3).
	 * Used to surface linting issues in the output channel after save.
	 */
	private countCjlintDiagnostics(uri: vscode.Uri): number {
		const diags = vscode.languages.getDiagnostics(uri)
		return diags.filter((d) => d.source === "cjlint").length
	}

	/**
	 * Run `cjpm build` in the given project root (queued per cwd).
	 * Defaults to incremental (`-i`) when safe; falls back to full build
	 * when cjpm.toml changed, target/ is missing, or incremental fails.
	 */
	async compile(cwd: string): Promise<CompileResult> {
		const prev = this.compileTailByCwd.get(cwd) ?? Promise.resolve()
		let result!: CompileResult
		const done = prev.then(async () => {
			result = await this.compileImpl(cwd)
		})
		this.compileTailByCwd.set(
			cwd,
			done.then(() => undefined, () => undefined),
		)
		await done
		return result
	}

	private async compileImpl(cwd: string): Promise<CompileResult> {
		this.tomlHashCache = null
		const t0 = Date.now()
		this._onCompile.fire({ status: "start", cwd })
		const cjpmPath = resolveCangjieToolPath("cjpm", "cangjieTools.cjpmPath")
		if (!cjpmPath) {
			const r: CompileResult = { success: false, output: "cjpm not found", errorCount: 0, errorLocations: [] }
			const dt = Date.now() - t0
			this.metricsCollector?.recordBuild(r, dt)
			void vscode.window.showErrorMessage(
				"未找到 cjpm：请设置 CANGJIE_HOME、PATH，或在设置中配置 njust-ai-cj.cangjieTools.cjpmPath。",
				"打开设置",
			).then((c) => {
				if (c === "打开设置") {
					void vscode.commands.executeCommand("workbench.action.openSettings", `${Package.name}.cangjieTools.cjpmPath`)
				}
			})
			this._onCompile.fire({
				status: "end",
				cwd,
				success: false,
				durationMs: dt,
				incremental: false,
				errorCount: 0,
				lastFullBuildMs: this.lastFullBuildDurationMs,
			})
			recordCompileHistoryEvent({
				cwd,
				success: false,
				incremental: false,
				durationMs: dt,
				errorCount: 0,
				errors: [{ file: "-", line: 0, message: "cjpm not found" }],
			})
			return r
		}

		const useIncremental = this.shouldUseIncremental(cwd)
		const args = useIncremental ? ["build", "-i"] : ["build"]
		const result = await this.execBuild(cjpmPath, args, cwd)
		result.incremental = useIncremental

		let final: CompileResult
		if (result.success) {
			this.publishCompileDiagnostics(cwd, result.errorLocations, result.output, true)
			this.onCjpmBuildSucceededForLsp?.({ cwd })
			this.lastCjpmTomlHash = this.computeTomlHash(cwd)
			if (useIncremental) {
				this.incrementalAvailable = true
				this.fullBuildCountSinceIncrementalFailure = 0
				this.outputChannel.appendLine(`[CompileGuard] ⚡ Incremental build succeeded`)
			}
			final = result
		} else if (useIncremental) {
			this.incrementalAvailable = false
			this.fullBuildCountSinceIncrementalFailure = 0
			this.outputChannel.appendLine(
				`[CompileGuard] Incremental build failed, retrying with full build…`,
			)
			const fullResult = await this.execBuild(cjpmPath, ["build"], cwd)
			fullResult.incremental = false
			if (fullResult.success) {
				this.publishCompileDiagnostics(cwd, fullResult.errorLocations, fullResult.output, true)
				this.onCjpmBuildSucceededForLsp?.({ cwd })
				this.lastCjpmTomlHash = this.computeTomlHash(cwd)
			} else {
				this.publishCompileDiagnostics(cwd, fullResult.errorLocations, fullResult.output, false)
			}
			final = fullResult
		} else {
			this.publishCompileDiagnostics(cwd, result.errorLocations, result.output, false)
			final = result
		}

		const durationMs = Date.now() - t0
		if (!final.incremental) {
			this.lastFullBuildDurationMs = durationMs
		}
		this.metricsCollector?.recordBuild(final, durationMs)
		if (!final.success) {
			for (const a of analyzeCompileOutput(final.output, final.errorLocations)) {
				this.metricsCollector?.recordErrorCategory(a.category)
			}
		}

		this._onCompile.fire({
			status: "end",
			cwd,
			success: final.success,
			durationMs,
			incremental: final.incremental,
			errorCount: final.errorCount,
			lastFullBuildMs: this.lastFullBuildDurationMs,
		})

		const historyErrors: Array<{ file: string; line: number; message: string }> = []
		if (!final.success) {
			for (const loc of final.errorLocations) {
				const keyRel = `${loc.file}:${loc.line}`
				const abs = path.isAbsolute(loc.file) ? loc.file : path.resolve(cwd, loc.file)
				const keyAbs = `${abs}:${loc.line}`
				const msg =
					this.lastErrors.get(keyRel) ??
					this.lastErrors.get(keyAbs) ??
					truncateCompileDiagnosticMessage(final.output, 400)
				historyErrors.push({ file: loc.file, line: loc.line, message: msg })
			}
			if (historyErrors.length === 0 && final.output.trim()) {
				const first = final.output
					.split(/\r?\n/)
					.map((l) => l.trim())
					.find((l) => l.length > 0)
				historyErrors.push({
					file: "-",
					line: 0,
					message: first ?? truncateCompileDiagnosticMessage(final.output, 400),
				})
			}
		}
		recordCompileHistoryEvent({
			cwd,
			success: final.success,
			incremental: final.incremental ?? false,
			durationMs,
			errorCount: final.errorCount,
			errors: historyErrors,
		})

		invalidateCangjieL3ContextCache()

		return final
	}

	private shouldUseIncremental(cwd: string): boolean {
		if (this.lastFullBuildDurationMs !== null && this.lastFullBuildDurationMs < 5_000) {
			return false
		}

		if (!this.incrementalAvailable) {
			this.fullBuildCountSinceIncrementalFailure++
			if (this.fullBuildCountSinceIncrementalFailure >= this.INCREMENTAL_RETRY_AFTER_FULL_BUILDS) {
				this.fullBuildCountSinceIncrementalFailure = 0
				this.incrementalAvailable = true
				this.outputChannel.appendLine(
					`[CompileGuard] 已连续 ${this.INCREMENTAL_RETRY_AFTER_FULL_BUILDS} 次全量编译，重新尝试增量编译 (-i)`,
				)
				// Fall through to target/toml checks below
			} else {
				return false
			}
		}

		const targetDir = path.join(cwd, "target")
		if (!fs.existsSync(targetDir)) {
			this.outputChannel.appendLine(`[CompileGuard] target/ missing — using full build`)
			return false
		}

		const currentHash = this.computeTomlHash(cwd)
		if (currentHash && this.lastCjpmTomlHash && currentHash !== this.lastCjpmTomlHash) {
			this.fullBuildCountSinceIncrementalFailure = 0
			this.outputChannel.appendLine(`[CompileGuard] cjpm.toml changed — using full build`)
			return false
		}

		return true
	}

	private computeTomlHash(cwd: string): string | undefined {
		if (this.tomlHashCache?.cwd === cwd) {
			return this.tomlHashCache.hash
		}
		try {
			const tomlPath = path.join(cwd, "cjpm.toml")
			if (!fs.existsSync(tomlPath)) {
				this.tomlHashCache = { cwd, hash: undefined }
				return undefined
			}
			const content = fs.readFileSync(tomlPath, "utf-8")
			const hash = createHash("md5").update(content).digest("hex")
			this.tomlHashCache = { cwd, hash }
			return hash
		} catch {
			this.tomlHashCache = { cwd, hash: undefined }
			return undefined
		}
	}

	private publishCompileDiagnostics(
		cwd: string,
		locations: CompileResult["errorLocations"],
		buildOutput: string,
		success: boolean,
	): void {
			// Clear only diagnostics under this project root (multi-project safe).
			if (this.compileDiagnostics) {
				for (const [uri] of this.compileDiagnostics) {
					if (uri.fsPath.startsWith(cwd)) {
						this.compileDiagnostics.delete(uri)
					}
				}
			}
			
		if (!this.compileDiagnostics) return
		if (locations.length === 0) {
			this.compileDiagnostics.clear()
			return
		}
		const byFile = new Map<string, vscode.Diagnostic[]>()
		for (const loc of locations) {
			const abs = path.isAbsolute(loc.file) ? loc.file : path.resolve(cwd, loc.file)
			let uri: vscode.Uri
			try {
				uri = vscode.Uri.file(abs)
			} catch {
				continue
			}
			const line = Math.max(0, loc.line - 1)
			const col = Math.max(0, loc.col - 1)
			const range = new vscode.Range(line, col, line, col + 1)
			const errKey = `${loc.file}:${loc.line}`
			const errKeyAbs = `${abs}:${loc.line}`
			const snippet =
				this.lastErrors.get(errKey) ?? this.lastErrors.get(errKeyAbs) ?? buildOutput.slice(0, 300)
			const diag = new vscode.Diagnostic(
				range,
				truncateCompileDiagnosticMessage(snippet, 500),
				vscode.DiagnosticSeverity.Error,
			)
			diag.source = "cjpm"
			if (!byFile.has(abs)) byFile.set(abs, [])
			byFile.get(abs)!.push(diag)
		}
		this.compileDiagnostics.clear()
		for (const [filePath, diags] of byFile) {
			this.compileDiagnostics.set(vscode.Uri.file(filePath), diags)
		}
	}

	private async execBuild(cjpmPath: string, args: string[], cwd: string): Promise<CompileResult> {
		try {
			const { stdout, stderr } = await execFileAsync(
				cjpmPath,
				args,
				{
					timeout: COMPILE_TIMEOUT_MS,
					cwd,
					env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
				},
			)
			const output = stdout + stderr
			this.lastErrors.clear()
			return { success: true, output, errorCount: 0, errorLocations: [] }
		} catch (error: unknown) {
			const err = error as { stdout?: string; stderr?: string; message?: string }
			const output = (err.stdout || "") + (err.stderr || "") + (err.message || "")

			const errorLocations: CompileResult["errorLocations"] = []
			this.lastErrors.clear()

			let match: RegExpExecArray | null
			CJC_ERROR_LOCATION_RE.lastIndex = 0
			while ((match = CJC_ERROR_LOCATION_RE.exec(output)) !== null) {
				const file = match[1]
				const line = parseInt(match[2], 10)
				const col = parseInt(match[3], 10)
				errorLocations.push({ file, line, col })
				this.lastErrors.set(`${file}:${line}`, normalizeErrorPattern(output.slice(match.index, match.index + 300)))
			}

			return {
				success: false,
				output,
				errorCount: errorLocations.length || 1,
				errorLocations,
			}
		}
	}

	/**
	 * Format a single .cj file using cjfmt.
	 */
	async formatFile(filePath: string): Promise<FormatResult> {
		const cjfmtPath = resolveCangjieToolPath("cjfmt", "cangjieTools.cjfmtPath")
		if (!cjfmtPath) {
			return { formatted: false, output: "cjfmt not found" }
		}

		const tmpOutput = path.join(os.tmpdir(), `cjfmt_guard_${Date.now()}.cj`)
		try {
			await execFileAsync(
				cjfmtPath,
				["-f", filePath, "-o", tmpOutput],
				{
					timeout: FORMAT_TIMEOUT_MS,
					env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
				},
			)

			if (!fs.existsSync(tmpOutput)) {
				return { formatted: false, output: "No output produced" }
			}

			const original = fs.readFileSync(filePath, "utf-8")
			const formatted = fs.readFileSync(tmpOutput, "utf-8")

			if (original !== formatted) {
				fs.writeFileSync(filePath, formatted, "utf-8")
				return { formatted: true, output: "File formatted" }
			}

			return { formatted: false, output: "Already formatted" }
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error)
			return { formatted: false, output: msg }
		} finally {
			try { fs.unlinkSync(tmpOutput) } catch {}
		}
	}

	/**
	 * Format all .cj files that have been modified (from visible editors).
	 */
	async formatDirtyCangjieFiles(): Promise<number> {
		let count = 0
		for (const editor of vscode.window.visibleTextEditors) {
			const doc = editor.document
			if ((doc.languageId === "cangjie" || doc.fileName.endsWith(".cj")) && doc.isDirty) {
				const result = await this.formatFile(doc.fileName)
				if (result.formatted) count++
			}
		}
		return count
	}

	private findCjpmRoot(uri: vscode.Uri): string | undefined {
		const folder = vscode.workspace.getWorkspaceFolder(uri)
		if (!folder) return undefined
		const tomlPath = path.join(folder.uri.fsPath, "cjpm.toml")
		return fs.existsSync(tomlPath) ? folder.uri.fsPath : undefined
	}

	private getSuggestionForError(errorMsg: string): string | null {
		// Map common error patterns to fix suggestions
		const patterns: Array<[RegExp, string]> = [
			[/undeclared|cannot find|not found|未找到符号/, "添加缺失的 import 语句或检查拼写"],
			[/type mismatch|incompatible types|类型不匹配/, "修正类型声明或添加类型转换"],
			[/immutable|cannot assign|不可变/, "将 let 改为 var"],
			[/non-exhaustive|incomplete match/, "补全 match 分支或添加 case _ =>"],
			[/mut function|mut.*let/, "将 let 改为 var 以允许调用 mut 方法"],
			[/missing return|no return/, "确保所有分支都有返回值"],
			[/recursive struct/, "struct 不能自引用，改用 class"],
			[/main.*Int64|main.*signature/, "main 函数签名必须为 main(): Int64"],
		]

		for (const [pattern, suggestion] of patterns) {
			if (pattern.test(errorMsg)) return suggestion
		}
		return null
	}

	dispose(): void {
		for (const t of this.compileDebounceByCwd.values()) {
			clearTimeout(t)
		}
		this.compileDebounceByCwd.clear()
		this.lintReportUriByCwd.clear()
		this.disposables.forEach((d) => d.dispose())
		this._onCompile.dispose()
	}

	// ── Phase 2.3: cjpm tree integration ──

	/**
	 * Run `cjpm tree` to get the exact dependency tree.
	 * Returns the tree output as text, or null if unavailable.
	 * This is more accurate than regex-parsing cjpm.toml.
	 */
	async runCjpmTree(cwd: string, depthLimit = 3): Promise<string | null> {
		const cjpmPath = resolveCangjieToolPath("cjpm", "cangjieTools.cjpmPath")
		if (!cjpmPath) return null

		try {
			const { stdout, stderr } = await execFileAsync(
				cjpmPath,
				["tree", "-V", "--depth", String(depthLimit)],
				{
					timeout: 15_000,
					cwd,
					env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
				},
			)
			const output = (stdout + stderr).trim()
			return output.length > 0 ? output : null
		} catch {
			// cjpm tree may not be available in all SDK versions
			return null
		}
	}

	/**
	 * Get a concise package dependency summary for the AI context.
	 * Delegates to shared {@link getCjpmTreeSummaryForPrompt} (module cache, no OutputChannel).
	 */
	async getCjpmTreeSummary(cwd: string): Promise<string> {
		return getCjpmTreeSummaryForPrompt(cwd)
	}
}
