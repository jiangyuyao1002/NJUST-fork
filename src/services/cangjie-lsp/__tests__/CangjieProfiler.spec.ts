import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	OverviewRulerLane: { Right: 4 },
	OutputChannel: class {},
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import { CangjieProfiler } from "../CangjieProfiler"

describe("CangjieProfiler", () => {
	let profiler: CangjieProfiler
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		profiler = new CangjieProfiler(mockOutput)
	})

	describe("profile", () => {
		it("returns failure when cjprof not found", async () => {
			const result = await profiler.profile("/test/project")
			expect(result.success).toBe(false)
			expect(result.output).toContain("not found")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => profiler.dispose()).not.toThrow()
		})
	})
})
