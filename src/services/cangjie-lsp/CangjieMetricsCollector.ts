import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { NJUST_AI_CONFIG_DIR, TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import type { CompileResult } from "./CangjieCompileGuard"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildMetric {
	timestamp: string
	success: boolean
	incremental: boolean
	errorCount: number
	durationMs?: number
}

export interface ErrorTrendEntry {
	date: string
	errorCount: number
	successCount: number
}

export interface ProjectMetrics {
	version: number
	projectName: string
	totalBuilds: number
	successfulBuilds: number
	failedBuilds: number
	avgErrorsPerFailedBuild: number
	recentBuilds: BuildMetric[]
	errorTrend: ErrorTrendEntry[]
	topErrors: Array<{ category: string; count: number }>
}

const METRICS_FILE = "build-metrics.json"
const METRICS_VERSION = 1
const MAX_RECENT_BUILDS = 100
const MAX_TREND_DAYS = 30

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class CangjieMetricsCollector implements vscode.Disposable {
	private metrics: ProjectMetrics
	private metricsPath: string
	private dirty = false
	private flushTimer: ReturnType<typeof setTimeout> | undefined

	constructor(
		cwd: string,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.metricsPath = path.join(cwd, NJUST_AI_CONFIG_DIR, METRICS_FILE)
		this.metrics = this.loadOrCreate(cwd)
	}

	/**
	 * Record a build result.
	 */
	recordBuild(result: CompileResult, durationMs?: number): void {
		const now = new Date()
		const metric: BuildMetric = {
			timestamp: now.toISOString(),
			success: result.success,
			incremental: result.incremental ?? false,
			errorCount: result.errorCount,
			durationMs,
		}

		this.metrics.totalBuilds++
		if (result.success) {
			this.metrics.successfulBuilds++
		} else {
			this.metrics.failedBuilds++
		}

		this.metrics.recentBuilds.push(metric)
		if (this.metrics.recentBuilds.length > MAX_RECENT_BUILDS) {
			this.metrics.recentBuilds = this.metrics.recentBuilds.slice(-MAX_RECENT_BUILDS)
		}

		this.updateErrorTrend(now, result)
		this.updateAvgErrors()
		this.scheduleSave()
	}

	/**
	 * Record an error category occurrence.
	 */
	recordErrorCategory(category: string): void {
		const existing = this.metrics.topErrors.find((e) => e.category === category)
		if (existing) {
			existing.count++
		} else {
			this.metrics.topErrors.push({ category, count: 1 })
		}
		this.metrics.topErrors.sort((a, b) => b.count - a.count)
		if (this.metrics.topErrors.length > 20) {
			this.metrics.topErrors = this.metrics.topErrors.slice(0, 20)
		}
		this.scheduleSave()
	}

	/**
	 * Get a summary string suitable for display in an output channel or webview.
	 */
	getSummary(): string {
		const m = this.metrics
		const successRate = m.totalBuilds > 0 ? ((m.successfulBuilds / m.totalBuilds) * 100).toFixed(1) : "N/A"

		const lines = [
			`Project Metrics: ${m.projectName}`,
			`Total builds: ${m.totalBuilds} (${successRate}% success)`,
			`Avg errors per failed build: ${m.avgErrorsPerFailedBuild.toFixed(1)}`,
			"",
			"Recent error trend:",
		]

		for (const entry of m.errorTrend.slice(-7)) {
			const bar = "█".repeat(Math.min(entry.errorCount, 20))
			lines.push(`  ${entry.date}: ${bar} ${entry.errorCount} errors, ${entry.successCount} ok`)
		}

		if (m.topErrors.length > 0) {
			lines.push("", "Top error categories:")
			for (const e of m.topErrors.slice(0, 5)) {
				lines.push(`  - ${e.category}: ${e.count}`)
			}
		}

		return lines.join("\n")
	}

	/**
	 * Get raw metrics data (for webview/dashboard consumption).
	 */
	getMetrics(): Readonly<ProjectMetrics> {
		return this.metrics
	}

	private updateErrorTrend(date: Date, result: CompileResult): void {
		const dateStr = date.toISOString().slice(0, 10)
		let entry = this.metrics.errorTrend.find((e) => e.date === dateStr)
		if (!entry) {
			entry = { date: dateStr, errorCount: 0, successCount: 0 }
			this.metrics.errorTrend.push(entry)
		}
		if (result.success) {
			entry.successCount++
		} else {
			entry.errorCount += result.errorCount
		}

		if (this.metrics.errorTrend.length > MAX_TREND_DAYS) {
			this.metrics.errorTrend = this.metrics.errorTrend.slice(-MAX_TREND_DAYS)
		}
	}

	private updateAvgErrors(): void {
		const failed = this.metrics.recentBuilds.filter((b) => !b.success)
		if (failed.length === 0) {
			this.metrics.avgErrorsPerFailedBuild = 0
			return
		}
		const totalErrors = failed.reduce((sum, b) => sum + b.errorCount, 0)
		this.metrics.avgErrorsPerFailedBuild = totalErrors / failed.length
	}

	private loadOrCreate(cwd: string): ProjectMetrics {
		if (fs.existsSync(this.metricsPath)) {
			try {
				const raw = fs.readFileSync(this.metricsPath, "utf-8")
				const parsed = JSON.parse(raw) as ProjectMetrics
				if (parsed.version === METRICS_VERSION) {
					return parsed
				}
			} catch {
				// intentionally ignored: start fresh on parse error
			}
		}

		const projectName = this.inferProjectName(cwd)
		return {
			version: METRICS_VERSION,
			projectName,
			totalBuilds: 0,
			successfulBuilds: 0,
			failedBuilds: 0,
			avgErrorsPerFailedBuild: 0,
			recentBuilds: [],
			errorTrend: [],
			topErrors: [],
		}
	}

	private inferProjectName(cwd: string): string {
		const tomlPath = path.join(cwd, "cjpm.toml")
		if (fs.existsSync(tomlPath)) {
			try {
				const content = fs.readFileSync(tomlPath, "utf-8")
				const m = content.match(/name\s*=\s*"([^"]+)"/)
				if (m) return m[1]!
			} catch {
				/* ignore */
			}
		}
		return path.basename(cwd)
	}

	private scheduleSave(): void {
		this.dirty = true
		if (this.flushTimer) return
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined
			this.saveToDisk()
		}, 5_000)
	}

	private saveToDisk(): void {
		if (!this.dirty) return
		try {
			const dir = path.dirname(this.metricsPath)
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
			fs.writeFileSync(this.metricsPath, JSON.stringify(this.metrics, null, 2), "utf-8")
			this.dirty = false
		} catch (err) {
			this.outputChannel.appendLine(`[Metrics] Failed to save: ${err}`)
			TelemetryService.reportError(err, TelemetryEventName.CANGJIE_LSP_ERROR)
		}
	}

	dispose(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
		}
		this.saveToDisk()
	}
}
