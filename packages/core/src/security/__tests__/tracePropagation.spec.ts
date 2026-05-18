import { describe, expect, it } from "vitest"
import { startTraceSpan } from "../metrics.js"

describe("trace propagation", () => {
	it("reuses provided parent trace id", () => {
		const parentTraceId = "trace-parent-123"
		const span = startTraceSpan("tool.handle", { tool: "read_file" }, parentTraceId)
		expect(span.traceId).toBe(parentTraceId)
		span.end("ok", { attempts: 1 })
	})
})
