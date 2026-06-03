/**
 * ActivationStats — compute percentiles from activation timing data.
 *
 * Reads NDJSON telemetry files and extracts `extension_activated` events
 * to produce P50/P95/P99 statistics.
 */

import fs from "fs"
import * as path from "path"

interface TelemetryEntry {
	t: number
	n: string
	p?: Record<string, unknown>
}

interface ActivationRecord {
	timestamp: number
	activationMs: number
	coldStart: boolean
}

export interface PercentileReport {
	/** Total number of activation events */
	sampleCount: number
	/** Date range */
	from: string
	to: string
	/** All activations */
	all: StatsSummary
	/** Cold-start activations only */
	cold: StatsSummary
	/** Warm-start activations only */
	warm: StatsSummary
}

export interface StatsSummary {
	p50: number
	p95: number
	p99: number
	mean: number
	max: number
	count: number
}

/** Read NDJSON files from a directory, filtered to the last N days. */
export function readActivationRecords(telemetryDir: string, days: number = 7): ActivationRecord[] {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
	const records: ActivationRecord[] = []

	if (!fs.existsSync(telemetryDir)) {
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
				const entry: TelemetryEntry = JSON.parse(line)
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

/** Compute percentile report from activation records. */
export function computePercentiles(records: ActivationRecord[]): PercentileReport {
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
	const from = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : "N/A"
	const to = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "N/A"

	return {
		sampleCount: records.length,
		from,
		to,
		all: statsFor(allMs),
		cold: statsFor(coldMs),
		warm: statsFor(warmMs),
	}
}

function statsFor(sorted: number[]): StatsSummary {
	if (sorted.length === 0) {
		return { p50: 0, p95: 0, p99: 0, mean: 0, max: 0, count: 0 }
	}
	return {
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
		max: sorted[sorted.length - 1] ?? 0,
		count: sorted.length,
	}
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 1) return sorted[0] ?? 0
	const idx = Math.ceil(p * sorted.length) - 1
	return sorted[Math.max(0, idx)] ?? 0
}
