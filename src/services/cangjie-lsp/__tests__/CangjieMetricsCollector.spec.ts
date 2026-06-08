import { describe, it, expect, vi, beforeEach } from "vitest"
// fs and path are mocked but not directly used in tests

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn().mockReturnValue(false),
			readFileSync: vi.fn(),
			writeFileSync: vi.fn(),
			mkdirSync: vi.fn(),
		},
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		mkdirSync: vi.fn(),
	}
})

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

vi.mock("@njust-ai/types", () => ({
	NJUST_AI_CONFIG_DIR: ".njust_ai",
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

import { CangjieMetricsCollector } from "../CangjieMetricsCollector"

describe("CangjieMetricsCollector", () => {
	let collector: CangjieMetricsCollector
	let mockOutput: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		collector = new CangjieMetricsCollector("/test/project", mockOutput as any)
	})

	describe("recordBuild", () => {
		it("records successful build", () => {
			collector.recordBuild({ success: true, incremental: false, errorCount: 0 }, 1000)
			const metrics = collector.getMetrics()
			expect(metrics.totalBuilds).toBe(1)
			expect(metrics.successfulBuilds).toBe(1)
			expect(metrics.failedBuilds).toBe(0)
		})

		it("records failed build", () => {
			collector.recordBuild({ success: false, incremental: false, errorCount: 3 }, 500)
			const metrics = collector.getMetrics()
			expect(metrics.totalBuilds).toBe(1)
			expect(metrics.failedBuilds).toBe(1)
			expect(metrics.recentBuilds[0].errorCount).toBe(3)
		})

		it("limits recent builds to 100", () => {
			for (let i = 0; i < 110; i++) {
				collector.recordBuild({ success: true, incremental: false, errorCount: 0 }, 100)
			}
			const metrics = collector.getMetrics()
			expect(metrics.recentBuilds.length).toBeLessThanOrEqual(100)
		})
	})

	describe("recordErrorCategory", () => {
		it("records error categories", () => {
			collector.recordErrorCategory("类型不匹配")
			collector.recordErrorCategory("类型不匹配")
			collector.recordErrorCategory("未找到符号")
			const metrics = collector.getMetrics()
			expect(metrics.topErrors.length).toBe(2)
			expect(metrics.topErrors[0].category).toBe("类型不匹配")
			expect(metrics.topErrors[0].count).toBe(2)
		})
	})

	describe("getSummary", () => {
		it("returns string summary", () => {
			collector.recordBuild({ success: true, incremental: false, errorCount: 0 }, 1000)
			const summary = collector.getSummary()
			expect(summary).toContain("Project Metrics")
			expect(summary).toContain("Total builds: 1")
		})

		it("shows N/A for success rate with no builds", () => {
			const summary = collector.getSummary()
			expect(summary).toContain("N/A")
		})
	})

	describe("getMetrics", () => {
		it("returns default metrics for new project", () => {
			const metrics = collector.getMetrics()
			expect(metrics.totalBuilds).toBe(0)
			expect(metrics.successfulBuilds).toBe(0)
			expect(metrics.failedBuilds).toBe(0)
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => collector.dispose()).not.toThrow()
		})
	})
})
