import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { resolveCangjieToolPath, buildCangjieToolEnv } from "./cangjieToolUtils"
import { getErrorMessage } from "../../shared/error-utils"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

const execFileAsync = promisify(execFile)

const PROFILE_TIMEOUT_MS = 120_000

export interface ProfileResult {
	success: boolean
	output: string
	hotPaths: HotPathEntry[]
}

export interface HotPathEntry {
	functionName: string
	filePath?: string
	line?: number
	selfTime: string
	totalTime: string
	percentage: number
}

/**
 * Integration with `cjprof` for runtime performance profiling of Cangjie programs.
 */
export class CangjieProfiler implements vscode.Disposable {
	private disposables: vscode.Disposable[] = []
	private decorationType: vscode.TextEditorDecorationType

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.decorationType = vscode.window.createTextEditorDecorationType({
			gutterIconSize: "contain",
			overviewRulerLane: vscode.OverviewRulerLane.Right,
		})
	}

	/**
	 * Run `cjprof run` on the current project's built executable.
	 */
	async profile(cwd: string, executablePath?: string): Promise<ProfileResult> {
		const cjprofPath = resolveCangjieToolPath("cjprof", "cangjieTools.cjprofPath")
		if (!cjprofPath) {
			return { success: false, output: "cjprof not found", hotPaths: [] }
		}

		const target = executablePath ?? this.findDefaultExecutable(cwd)
		if (!target) {
			return { success: false, output: "No executable found in target/release/bin/", hotPaths: [] }
		}

		try {
			const { stdout, stderr } = await execFileAsync(
				cjprofPath,
				["run", target],
				{
					timeout: PROFILE_TIMEOUT_MS,
					cwd,
					env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
				},
			)
			const output = stdout + stderr
			const hotPaths = this.parseProfileOutput(output)

			this.outputChannel.appendLine(`[Profiler] Profile completed: ${hotPaths.length} hot paths found`)
			return { success: true, output, hotPaths }
		} catch (error: unknown) {
			const msg = getErrorMessage(error)
			this.outputChannel.appendLine(`[Profiler] Profile failed: ${msg}`)
			TelemetryService.reportError(error, TelemetryEventName.CANGJIE_LSP_ERROR)
			return { success: false, output: msg, hotPaths: [] }
		}
	}

	/**
	 * Apply heat-map decorations to visible editors based on profiling results.
	 */
	applyHeatMap(results: ProfileResult): void {
		if (results.hotPaths.length === 0) return

		for (const editor of vscode.window.visibleTextEditors) {
			const filePath = editor.document.fileName
			const relevantPaths = results.hotPaths.filter(
				(h) => h.filePath && path.resolve(h.filePath) === path.resolve(filePath),
			)

			if (relevantPaths.length === 0) continue

			const decorations: vscode.DecorationOptions[] = relevantPaths
				.filter((h) => h.line !== undefined)
				.map((h) => {
					const line = h.line! - 1
					const range = new vscode.Range(line, 0, line, 0)
					const hoverMsg = new vscode.MarkdownString(
						`**${h.functionName}** — self: ${h.selfTime}, total: ${h.totalTime} (${h.percentage.toFixed(1)}%)`,
					)
					return { range, hoverMessage: hoverMsg }
				})

			editor.setDecorations(this.decorationType, decorations)
		}
	}

	/**
	 * Show profiler results in a quick-pick summary.
	 */
	async showProfileSummary(results: ProfileResult): Promise<void> {
		if (results.hotPaths.length === 0) {
			vscode.window.showInformationMessage("No hot paths found in profile results.")
			return
		}

		const items = results.hotPaths.slice(0, 20).map((h, i) => ({
			label: `${i + 1}. ${h.functionName}`,
			description: `${h.percentage.toFixed(1)}%`,
			detail: `self: ${h.selfTime}, total: ${h.totalTime}${h.filePath ? ` — ${h.filePath}:${h.line}` : ""}`,
			entry: h,
		}))

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: "Profile hot paths (click to navigate)",
		})

		if (selected?.entry.filePath && selected.entry.line) {
			const uri = vscode.Uri.file(selected.entry.filePath)
			const pos = new vscode.Position(selected.entry.line - 1, 0)
			const doc = await vscode.workspace.openTextDocument(uri)
			await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) })
		}
	}

	private findDefaultExecutable(cwd: string): string | undefined {
		const binDir = path.join(cwd, "target", "release", "bin")
		if (!fs.existsSync(binDir)) return undefined

		try {
			const entries = fs.readdirSync(binDir)
			const exe = entries.find((e) => !e.endsWith(".d") && !e.endsWith(".pdb"))
			return exe ? path.join(binDir, exe) : undefined
		} catch {
			return undefined
		}
	}

	/**
	 * Parse cjprof output into structured hot path entries.
	 * Attempts JSON first, falls back to line-based parsing.
	 */
	private parseProfileOutput(output: string): HotPathEntry[] {
		// Try JSON format first
		try {
			// Find JSON array by "[{" to avoid log-line false positives.
			const jsonStart = output.indexOf("[{")
			const jsonEnd = jsonStart >= 0 ? output.indexOf("}]", jsonStart) : -1
			if (jsonStart >= 0 && jsonEnd > jsonStart) {
					const json = JSON.parse(output.slice(jsonStart, jsonEnd + 2)) as Array<{
					function?: string
					file?: string
					line?: number
					self_time?: string
					total_time?: string
					percentage?: number
				}>
				return json.map((entry) => ({
					functionName: entry.function ?? "unknown",
					filePath: entry.file,
					line: entry.line,
					selfTime: entry.self_time ?? "?",
					totalTime: entry.total_time ?? "?",
					percentage: entry.percentage ?? 0,
				}))
			}
		} catch {
			// Not JSON, try line-based
		}

		// Line-based fallback: look for tabular output
		const entries: HotPathEntry[] = []
		const lines = output.split("\n")
		const lineRe = /^\s*([\d.]+)%\s+([\d.]+\w*)\s+([\d.]+\w*)\s+(.+?)(?:\s+\((.+?):(\d+)\))?$/

		for (const line of lines) {
			const m = lineRe.exec(line)
			if (m) {
				entries.push({
					percentage: parseFloat(m[1]!),
					selfTime: m[2]!,
					totalTime: m[3]!,
					functionName: m[4]!.trim(),
					filePath: m[5],
					line: m[6] ? parseInt(m[6], 10) : undefined,
				})
			}
		}

		return entries.sort((a, b) => b.percentage - a.percentage)
	}

	dispose(): void {
		this.decorationType.dispose()
		this.disposables.forEach((d) => d.dispose())
	}
}
