import { randomUUID } from "node:crypto"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { logger } from "../shared/logger.js"

type SecurityMetricName =
	| "tool_cache_hit"
	| "tool_cache_miss"
	| "tool_retry"
	| "tool_retry_success"
	| "permission_deny"
	| "permission_bypass_allow"
	| "permission_bypass_hardened_ask"
	| "permission_auto_downgrade"
	| "execute_command_high_risk"
	| "tool_exec_duration_ms"
	| "tool_memory_delta_mb"
	| "tool_memory_rss_mb"

export function recordSecurityMetric(name: SecurityMetricName, attrs: Record<string, string | number | boolean> = {}): void {
	const payload = Object.entries(attrs)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(" ")
	logger.info("SecurityMetric", `[SecurityMetric] ${name}${payload ? ` ${payload}` : ""}`)

	try {
		TelemetryService.instance.captureEvent(`security.${name}`, attrs)
	} catch (error) {
		logger.warn("SecurityMetric", `telemetry capture failed for ${name}:`, error)
	}
}

export function startTraceSpan(
	name: string,
	attrs: Record<string, string | number | boolean> = {},
	parentTraceId?: string,
): { traceId: string; spanId: string; end: (status: "ok" | "error", endAttrs?: Record<string, string | number | boolean>) => void } {
	const fallbackTraceId = (parentTraceId ?? randomUUID()) as `${string}-${string}-${string}-${string}-${string}`
	const fallbackSpanId = randomUUID()
	const startedAt = Date.now()

	let runtimeTraceId: string = fallbackTraceId
	let runtimeSpanId: string = fallbackSpanId
	const otel = TelemetryService.instance.startSpan(name, {
		...attrs,
		...(parentTraceId ? { parentTraceId } : {}),
	})
	if (otel) {
		runtimeTraceId = otel.traceId
		runtimeSpanId = otel.spanId
	}

	try {
		TelemetryService.instance.captureEvent(`trace.${name}.start`, { traceId: runtimeTraceId, spanId: runtimeSpanId, ...attrs })
	} catch {
		// no-op
	}

	return {
		traceId: runtimeTraceId,
		spanId: runtimeSpanId,
		end: (status, endAttrs = {}) => {
			const durationMs = Date.now() - startedAt
			try {
				TelemetryService.instance.captureEvent(`trace.${name}.end`, {
					traceId: runtimeTraceId,
					spanId: runtimeSpanId,
					status,
					durationMs,
					...attrs,
					...endAttrs,
				})
			} catch {
				// no-op
			}
			try {
				TelemetryService.instance.endSpan(runtimeSpanId, status, { durationMs, ...endAttrs })
			} catch {
				// no-op
			}
		},
	}
}
