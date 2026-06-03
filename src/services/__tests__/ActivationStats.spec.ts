import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import * as path from "path"
import * as os from "os"

import { readActivationRecords, computePercentiles } from "../../../packages/telemetry/src/ActivationStats"

describe("ActivationStats", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "activation-stats-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	function writeNdjson(filename: string, entries: Array<{ t: number; n: string; p?: Record<string, unknown> }>) {
		const content = entries.map((e) => JSON.stringify(e)).join("\n")
		fs.writeFileSync(path.join(tmpDir, filename), content)
	}

	describe("readActivationRecords", () => {
		it("reads extension_activated events from NDJSON files", () => {
			writeNdjson("events-20260603.ndjson", [
				{ t: Date.now() - 1000, n: "extension_activated", p: { activationMs: 500, coldStart: true } },
				{ t: Date.now() - 2000, n: "extension_activated", p: { activationMs: 200, coldStart: false } },
				{ t: Date.now() - 3000, n: "other_event", p: { foo: "bar" } }, // Should be filtered out
			])

			const records = readActivationRecords(tmpDir, 7)
			expect(records).toHaveLength(2)
			expect(records[0].activationMs).toBe(500)
			expect(records[0].coldStart).toBe(true)
			expect(records[1].activationMs).toBe(200)
		})

		it("filters out records older than N days", () => {
			const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
			writeNdjson("events-20260524.ndjson", [
				{ t: tenDaysAgo, n: "extension_activated", p: { activationMs: 800, coldStart: true } },
			])
			writeNdjson("events-20260603.ndjson", [
				{ t: Date.now(), n: "extension_activated", p: { activationMs: 300, coldStart: false } },
			])

			const records = readActivationRecords(tmpDir, 7)
			expect(records).toHaveLength(1)
			expect(records[0].activationMs).toBe(300)
		})

		it("returns empty array for non-existent directory", () => {
			const records = readActivationRecords("/nonexistent/path", 7)
			expect(records).toHaveLength(0)
		})

		it("skips malformed lines", () => {
			fs.writeFileSync(path.join(tmpDir, "events-20260603.ndjson"), "not-json\n{also bad\n")
			const records = readActivationRecords(tmpDir, 7)
			expect(records).toHaveLength(0)
		})
	})

	describe("computePercentiles", () => {
		it("computes P50/P95/P99 for activation records", () => {
			const records = Array.from({ length: 100 }, (_, i) => ({
				timestamp: Date.now() - i * 1000,
				activationMs: (i + 1) * 10, // 10, 20, 30, ..., 1000
				coldStart: i < 30, // 30 cold, 70 warm
			}))

			const report = computePercentiles(records)
			expect(report.sampleCount).toBe(100)
			expect(report.all.p50).toBe(500)
			expect(report.all.p95).toBe(950)
			expect(report.all.p99).toBe(990)
			expect(report.all.max).toBe(1000)

			// Cold starts should have lower values (first 30: 10-300)
			expect(report.cold.count).toBe(30)
			expect(report.cold.max).toBe(300)

			// Warm starts should have higher values (last 70: 310-1000)
			expect(report.warm.count).toBe(70)
		})

		it("handles empty records", () => {
			const report = computePercentiles([])
			expect(report.sampleCount).toBe(0)
			expect(report.all.p50).toBe(0)
			expect(report.all.p95).toBe(0)
		})

		it("handles single record", () => {
			const report = computePercentiles([{ timestamp: Date.now(), activationMs: 420, coldStart: true }])
			expect(report.sampleCount).toBe(1)
			expect(report.all.p50).toBe(420)
			expect(report.all.p95).toBe(420)
			expect(report.cold.count).toBe(1)
			expect(report.warm.count).toBe(0)
		})
	})
})
