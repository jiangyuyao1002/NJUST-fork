import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockMkdirSync: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	OutputChannel: class {},
	Disposable: class {},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: mockExistsSync,
			readFileSync: mockReadFileSync,
			writeFileSync: mockWriteFileSync,
			mkdirSync: mockMkdirSync,
		},
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
		writeFileSync: mockWriteFileSync,
		mkdirSync: mockMkdirSync,
	}
})

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	NJUST_AI_CONFIG_DIR: ".njust-ai",
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import { CangjieMetricsCollector } from "../CangjieMetricsCollector"
import { TelemetryService } from "@njust-ai/telemetry"

describe("CangjieMetricsCollector", () => {
	let collector: CangjieMetricsCollector
	let mockOutput: any

	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		mockExistsSync.mockReset()
		mockExistsSync.mockReturnValue(false)
		mockWriteFileSync.mockReset()
		mockMkdirSync.mockReset()
		mockReadFileSync.mockReset()
		collector = new CangjieMetricsCollector("/ws", mockOutput)
	})

	afterEach(() => {
		collector.dispose()
		vi.useRealTimers()
	})

	// helper: create a fresh collector with existing metrics file
	function createCollectorWithMetrics(metrics: object) {
		mockExistsSync.mockReturnValue(true)
		mockReadFileSync.mockReturnValue(JSON.stringify(metrics))
		return new CangjieMetricsCollector("/ws", mockOutput)
	}

	// ── constructor / loadOrCreate ───────────────────────────────────

	describe("constructor", () => {
		it("creates instance with default metrics", () => {
			expect(collector).toBeDefined()
			expect(collector.getMetrics().version).toBe(1)
			expect(collector.getMetrics().totalBuilds).toBe(0)
		})

		it("loads existing metrics when file exists with correct version", () => {
			const c = createCollectorWithMetrics({
				version: 1,
				projectName: "test",
				totalBuilds: 5,
				successfulBuilds: 3,
				failedBuilds: 2,
				avgErrorsPerFailedBuild: 1.5,
				recentBuilds: [],
				errorTrend: [],
				topErrors: [],
			})
			expect(c.getMetrics().totalBuilds).toBe(5)
			expect(c.getMetrics().projectName).toBe("test")
			c.dispose()
		})

		it("creates new metrics when version mismatch", () => {
			const c = createCollectorWithMetrics({
				version: 99,
				projectName: "old",
				totalBuilds: 100,
				successfulBuilds: 50,
				failedBuilds: 50,
				avgErrorsPerFailedBuild: 0,
				recentBuilds: [],
				errorTrend: [],
				topErrors: [],
			})
			expect(c.getMetrics().totalBuilds).toBe(0)
			expect(c.getMetrics().version).toBe(1)
			c.dispose()
		})

		it("creates new metrics when JSON is corrupt", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("not valid json{{{")
			const c = new CangjieMetricsCollector("/ws", mockOutput)
			expect(c.getMetrics().totalBuilds).toBe(0)
			c.dispose()
		})
	})

	// ── inferProjectName ───────────────────────────────────────────

	describe("inferProjectName", () => {
		it("extracts name from cjpm.toml", () => {
			mockExistsSync
				.mockReturnValueOnce(false) // metrics file
				.mockReturnValueOnce(true) // cjpm.toml
			mockReadFileSync.mockReturnValue('name = "MyProject"\nversion = "1.0"')
			const c = new CangjieMetricsCollector("/ws", mockOutput)
			expect(c.getMetrics().projectName).toBe("MyProject")
			c.dispose()
		})

		it("falls back to basename when toml has no name", () => {
			mockExistsSync
				.mockReturnValueOnce(false) // metrics file
				.mockReturnValueOnce(true) // cjpm.toml
			mockReadFileSync.mockReturnValue("version = 1.0")
			const c = new CangjieMetricsCollector("/projects/MyApp", mockOutput)
			expect(c.getMetrics().projectName).toBe("MyApp")
			c.dispose()
		})

		it("falls back to basename when cjpm.toml not found", () => {
			mockExistsSync.mockReturnValue(false)
			const c = new CangjieMetricsCollector("/projects/TestApp", mockOutput)
			expect(c.getMetrics().projectName).toBe("TestApp")
			c.dispose()
		})

		it("falls back to basename when toml read fails", () => {
			mockExistsSync
				.mockReturnValueOnce(false) // metrics file
				.mockReturnValueOnce(true) // cjpm.toml
			mockReadFileSync.mockImplementation(() => {
				throw new Error("EACCES")
			})
			const c = new CangjieMetricsCollector("/projects/Fallback", mockOutput)
			expect(c.getMetrics().projectName).toBe("Fallback")
			c.dispose()
		})
	})

	// ── recordBuild ──────────────────────────────────────────────────

	describe("recordBuild", () => {
		it("increments successful builds", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			const m = collector.getMetrics()
			expect(m.totalBuilds).toBe(1)
			expect(m.successfulBuilds).toBe(1)
			expect(m.failedBuilds).toBe(0)
		})

		it("increments failed builds on failure", () => {
			collector.recordBuild({ success: false, output: "error", errorCount: 2, errorLocations: [] })
			const m = collector.getMetrics()
			expect(m.totalBuilds).toBe(1)
			expect(m.successfulBuilds).toBe(0)
			expect(m.failedBuilds).toBe(1)
		})

		it("tracks recent builds", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			collector.recordBuild({ success: false, output: "err", errorCount: 1, errorLocations: [] })
			expect(collector.getMetrics().recentBuilds.length).toBe(2)
		})

		it("records durationMs in build metric", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] }, 1500)
			const build = collector.getMetrics().recentBuilds[0]
			expect(build.durationMs).toBe(1500)
		})

		it("sets incremental flag", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [], incremental: true })
			expect(collector.getMetrics().recentBuilds[0].incremental).toBe(true)
		})

		it("defaults incremental to false", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			expect(collector.getMetrics().recentBuilds[0].incremental).toBe(false)
		})

		it("limits recentBuilds to 100", () => {
			for (let i = 0; i < 110; i++) {
				collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			}
			expect(collector.getMetrics().recentBuilds.length).toBeLessThanOrEqual(100)
		})
	})

	// ── recordErrorCategory ──────────────────────────────────────────

	describe("recordErrorCategory", () => {
		it("records and sorts error categories", () => {
			collector.recordErrorCategory("type_mismatch")
			collector.recordErrorCategory("type_mismatch")
			collector.recordErrorCategory("syntax_error")
			const m = collector.getMetrics()
			expect(m.topErrors).toHaveLength(2)
			expect(m.topErrors[0].category).toBe("type_mismatch")
			expect(m.topErrors[0].count).toBe(2)
		})

		it("limits topErrors to 20", () => {
			for (let i = 0; i < 25; i++) {
				collector.recordErrorCategory(`cat_${i}`)
			}
			expect(collector.getMetrics().topErrors.length).toBeLessThanOrEqual(20)
		})
	})

	// ── error trend ──────────────────────────────────────────────────

	describe("error trend", () => {
		it("tracks error trend by date", () => {
			collector.recordBuild({ success: false, output: "err", errorCount: 3, errorLocations: [] })
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			const trend = collector.getMetrics().errorTrend
			expect(trend.length).toBeGreaterThan(0)
			expect(trend[0].errorCount).toBe(3)
			expect(trend[0].successCount).toBe(1)
		})

		it("accumulates errors for same date", () => {
			collector.recordBuild({ success: false, output: "err", errorCount: 2, errorLocations: [] })
			collector.recordBuild({ success: false, output: "err", errorCount: 5, errorLocations: [] })
			expect(collector.getMetrics().errorTrend[0].errorCount).toBe(7)
		})
	})

	// ── avgErrorsPerFailedBuild ──────────────────────────────────────

	describe("avgErrorsPerFailedBuild", () => {
		it("calculates average correctly", () => {
			collector.recordBuild({ success: false, output: "err", errorCount: 2, errorLocations: [] })
			collector.recordBuild({ success: false, output: "err", errorCount: 4, errorLocations: [] })
			expect(collector.getMetrics().avgErrorsPerFailedBuild).toBe(3)
		})

		it("returns 0 when no failed builds", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			expect(collector.getMetrics().avgErrorsPerFailedBuild).toBe(0)
		})
	})

	// ── getSummary ───────────────────────────────────────────────────

	describe("getSummary", () => {
		it("includes project name and build count", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			const s = collector.getSummary()
			expect(s).toContain("Project Metrics")
			expect(s).toContain("Total builds: 1")
		})

		it("shows N/A success rate when no builds", () => {
			expect(collector.getSummary()).toContain("N/A")
		})

		it("includes recent error trend entries", () => {
			collector.recordBuild({ success: false, output: "err", errorCount: 5, errorLocations: [] })
			expect(collector.getSummary()).toContain("errors")
		})

		it("includes top error categories", () => {
			collector.recordErrorCategory("type_error")
			collector.recordErrorCategory("type_error")
			const s = collector.getSummary()
			expect(s).toContain("type_error")
			expect(s).toContain("2")
		})

		it("limits trend display to last 7 entries", () => {
			// Manually inject 10 trend entries
			const m = collector.getMetrics() as any
			for (let i = 0; i < 10; i++) {
				m.errorTrend.push({ date: `2025-01-${String(i + 1).padStart(2, "0")}`, errorCount: i, successCount: 0 })
			}
			const s = collector.getSummary()
			// Should only show last 7
			expect(s).toContain("2025-01-04")
			expect(s).not.toContain("2025-01-01")
		})
	})

	// ── scheduleSave / saveToDisk ────────────────────────────────────

	describe("scheduleSave / saveToDisk", () => {
		it("debounces save: does not write before 5 seconds", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(4999)
			expect(mockWriteFileSync).not.toHaveBeenCalled()
		})

		it("saves after 5 second debounce", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockWriteFileSync).toHaveBeenCalled()
		})

		it("creates directory if it does not exist", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true })
		})

		it("skips mkdir when directory already exists", () => {
			mockExistsSync.mockReturnValue(true)
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockMkdirSync).not.toHaveBeenCalled()
		})

		it("merges multiple rapid saves into one write", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			collector.recordBuild({ success: false, output: "err", errorCount: 1, errorLocations: [] })
			collector.recordErrorCategory("some_error")
			vi.advanceTimersByTime(5000)
			expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
		})

		it("saves again after previous debounce completed", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockWriteFileSync).toHaveBeenCalledTimes(1)

			collector.recordBuild({ success: false, output: "err", errorCount: 2, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockWriteFileSync).toHaveBeenCalledTimes(2)
		})

		it("writes valid JSON with metrics data", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			const written = mockWriteFileSync.mock.calls[0][1]
			const parsed = JSON.parse(written)
			expect(parsed.totalBuilds).toBe(1)
			expect(parsed.version).toBe(1)
		})

		it("logs and reports telemetry on write failure", () => {
			mockWriteFileSync.mockImplementation(() => {
				throw new Error("EACCES")
			})
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000)
			expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("Failed to save"))
			expect(TelemetryService.reportError).toHaveBeenCalled()
		})

		it("does not save when not dirty", () => {
			// No recordBuild called → dirty is false
			;(collector as any).saveToDisk()
			expect(mockWriteFileSync).not.toHaveBeenCalled()
		})

		it("clears dirty flag after successful save", () => {
			// Manually set dirty and verify saveToDisk clears it
			;(collector as any).dirty = true
			;(collector as any).saveToDisk()
			expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
			expect((collector as any).dirty).toBe(false)
		})
	})

	// ── dispose ──────────────────────────────────────────────────────

	describe("dispose", () => {
		it("clears pending timer and saves immediately", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			// Not yet saved (debounce pending)
			expect(mockWriteFileSync).not.toHaveBeenCalled()
			collector.dispose()
			// Should save on dispose
			expect(mockWriteFileSync).toHaveBeenCalled()
		})

		it("saves even without pending timer when dirty", () => {
			collector.recordBuild({ success: true, output: "", errorCount: 0, errorLocations: [] })
			vi.advanceTimersByTime(5000) // first save
			mockWriteFileSync.mockClear()

			// Make dirty again
			;(collector as any).dirty = true
			collector.dispose()
			expect(mockWriteFileSync).toHaveBeenCalled()
		})

		it("does not throw when no pending save", () => {
			expect(() => collector.dispose()).not.toThrow()
		})
	})

	// ── getMetrics ───────────────────────────────────────────────────

	describe("getMetrics", () => {
		it("returns readonly metrics", () => {
			const m = collector.getMetrics()
			expect(m).toBeDefined()
			expect(m.version).toBe(1)
			expect(m.projectName).toBeDefined()
		})
	})
})
