import { describe, expect, it, vi } from "vitest"
import { TelemetryService } from "@njust-ai/telemetry"
import { recordSecurityMetric, startTraceSpan } from "../metrics.js"

describe("recordSecurityMetric", () => {
	it("sends security event to telemetry service", () => {
		const spy = vi.spyOn(TelemetryService.instance, "captureEvent")
		recordSecurityMetric("tool_cache_hit", { tool: "read_file", attempt: 1 })
		expect(spy).toHaveBeenCalledWith("security.tool_cache_hit", { tool: "read_file", attempt: 1 })
		spy.mockRestore()
	})
})

describe("startTraceSpan", () => {
	it("emits start/end trace events with ids", () => {
		const spy = vi.spyOn(TelemetryService.instance, "captureEvent")
		const span = startTraceSpan("tool.handle", { tool: "read_file" }, "trace-1")
		span.end("ok", { attempts: 1 })
		expect(spy).toHaveBeenCalledWith(
			"trace.tool.handle.start",
			expect.objectContaining({ traceId: "trace-1", tool: "read_file" }),
		)
		expect(spy).toHaveBeenCalledWith(
			"trace.tool.handle.end",
			expect.objectContaining({ traceId: "trace-1", status: "ok", attempts: 1 }),
		)
		spy.mockRestore()
	})
})
