#!/usr/bin/env node

/**
 * report-activation-perf.mjs
 *
 * Reads telemetry NDJSON files and computes P50/P95/P99 for extension
 * activation times. Designed to run locally or in CI.
 *
 * Usage:
 *   node scripts/report-activation-perf.mjs [telemetry-dir] [--days=7] [--json]
 *
 * If no directory is given, defaults to the VS Code globalStorage telemetry path
 * for the current user (auto-detected per platform).
 */

import fs from "fs"
import * as path from "path"
import * as os from "os"

// ── Inline percentile logic (no TS imports in .mjs scripts) ─────────

function readActivationRecords(telemetryDir, days = 7) {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
	const records = []

	if (!fs.existsSync(telemetryDir)) {
		console.error(`Telemetry directory not found: ${telemetryDir}`)
		return records
	}

	const files = fs
		.readdirSync(telemetryDir)
		.filter((f) => f.startsWith("events-") && f.endsWith(".ndjson"))
		.sort()

	for (const file of files) {
		const filePath = path.join(telemetryDir, file)
		const content = fs.readFileSync(filePath, "utf-8")
		for (const line of content.split("\n")) {
			if (!line.trim()) continue
			try {
				const entry = JSON.parse(line)
				if (entry.n !== "extension_activated" || !entry.p) continue
				if (entry.t < cutoff) continue

				const activationMs = Number(entry.p.activationMs)
				if (!Number.isFinite(activationMs) || activationMs <= 0) continue

				records.push({
					timestamp: entry.t,
					activationMs,
					coldStart: entry.p.coldStart === true,
				})
			} catch {
				// Skip malformed lines
			}
		}
	}

	return records
}

function percentile(sorted, p) {
	if (sorted.length === 0) return 0
	if (sorted.length === 1) return sorted[0]
	const idx = Math.ceil(p * sorted.length) - 1
	return sorted[Math.max(0, idx)]
}

function statsFor(sorted) {
	if (sorted.length === 0) {
		return { p50: 0, p95: 0, p99: 0, mean: 0, max: 0, count: 0 }
	}
	return {
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
		max: sorted[sorted.length - 1],
		count: sorted.length,
	}
}

// ── Default telemetry path detection ────────────────────────────────

function getDefaultTelemetryDir() {
	const home = os.homedir()
	const platform = process.platform

	if (platform === "win32") {
		return path.join(home, "AppData", "Roaming", "Code", "User", "globalStorage", "njust-ai.njust-ai", "telemetry")
	} else if (platform === "darwin") {
		return path.join(
			home,
			"Library",
			"Application Support",
			"Code",
			"User",
			"globalStorage",
			"njust-ai.njust-ai",
			"telemetry",
		)
	} else {
		return path.join(home, ".config", "Code", "User", "globalStorage", "njust-ai.njust-ai", "telemetry")
	}
}

// ── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonOutput = args.includes("--json")
const daysArg = args.find((a) => a.startsWith("--days="))
const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 7
const dirArg = args.find((a) => !a.startsWith("--"))
const telemetryDir = dirArg || getDefaultTelemetryDir()

const records = readActivationRecords(telemetryDir, days)

if (records.length === 0) {
	if (jsonOutput) {
		console.log(JSON.stringify({ sampleCount: 0, message: "No activation records found" }))
	} else {
		console.log(`No activation records found in ${telemetryDir} (last ${days} days)`)
		console.log(`Tip: ensure the extension has been activated at least once.`)
	}
	process.exit(0)
}

const allMs = records.map((r) => r.activationMs).sort((a, b) => a - b)
const coldMs = records
	.filter((r) => r.coldStart)
	.map((r) => r.activationMs)
	.sort((a, b) => a - b)
const warmMs = records
	.filter((r) => !r.coldStart)
	.map((r) => r.activationMs)
	.sort((a, b) => a - b)

const timestamps = records.map((r) => r.timestamp)
const from = new Date(Math.min(...timestamps)).toISOString()
const to = new Date(Math.max(...timestamps)).toISOString()

const report = {
	sampleCount: records.length,
	from,
	to,
	all: statsFor(allMs),
	cold: statsFor(coldMs),
	warm: statsFor(warmMs),
}

if (jsonOutput) {
	console.log(JSON.stringify(report, null, 2))
} else {
	console.log(`\nActivation Performance Report`)
	console.log(`══════════════════════════════════════════`)
	console.log(`  Samples: ${report.sampleCount}  (${from} → ${to})\n`)

	const printStats = (label, stats) => {
		if (stats.count === 0) {
			console.log(`  ${label}: no data`)
			return
		}
		console.log(
			`  ${label} (n=${stats.count}): P50=${stats.p50}ms  P95=${stats.p95}ms  P99=${stats.p99}ms  mean=${stats.mean}ms  max=${stats.max}ms`,
		)
	}

	printStats("All ", report.all)
	printStats("Cold", report.cold)
	printStats("Warm", report.warm)
	console.log()
}
