import { MAX_DEFERRED_RUN_ID_LENGTH, MIN_DEFERRED_PROTOCOL_VERSION } from "./deferredConstants"
import type { DeferredResponse, DeferredToolCall } from "./types"
import { logger } from "../../shared/logger"

function pickNonEmptyString(...candidates: unknown[]): string | undefined {
	for (const v of candidates) {
		if (typeof v === "string" && v.trim().length > 0) {
			return v
		}
	}
	return undefined
}

function parseArgumentsField(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) {
		return {}
	}
	if (typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>
	}
	if (typeof raw === "string") {
		const s = raw.trim()
		if (!s) return {}
		try {
			if (s.length > 10485760) {
				logger.error(
					"CloudAgent",
					`Arguments string exceeds size limit ` + `(${s.length} > 10485760), dropping to prevent OOM.`,
				)
				return { _arguments_parse_failed: true as const, _raw_arguments: s.slice(0, 200) + "..." }
			}
			const parsed = JSON.parse(s) as unknown
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>
			}
		} catch {
			return { _arguments_parse_failed: true as const, _raw_arguments: s }
		}
	}
	return {}
}

/**
 * Parse one pending tool entry from either NJUST deferred shape or OpenAI-style `tool_calls[]`.
 */
export function parseDeferredToolCallItem(item: unknown): DeferredToolCall | null {
	if (!item || typeof item !== "object") {
		return null
	}
	const o = item as Record<string, unknown>

	const callId = pickNonEmptyString(o.call_id, o.id, o.tool_call_id)
	let tool = pickNonEmptyString(o.tool, o.name)
	let args = parseArgumentsField(o.arguments)

	const fn = o.function
	if (fn && typeof fn === "object") {
		const f = fn as Record<string, unknown>
		tool = tool ?? pickNonEmptyString(f.name)
		const fnArgs = f.arguments
		if (fnArgs !== undefined) {
			args = parseArgumentsField(fnArgs)
		}
	}

	if (!callId || !tool) {
		return null
	}
	return { call_id: callId, tool, arguments: args }
}

/**
 * Some servers send `tool_calls` (OpenAI-like) instead of `pending_tools`. Normalize so Task always
 * executes and resumes with matching counts.
 * When both are present, merge by `call_id` (pending_tools wins on duplicates).
 */
export function normalizeDeferredResponse(raw: unknown): DeferredResponse {
	if (!raw || typeof raw !== "object") {
		throw new Error("Cloud Agent: deferred response is not a JSON object")
	}
	const r = raw as DeferredResponse & { tool_calls?: unknown[] }

	const fromPending = Array.isArray(r.pending_tools)
		? r.pending_tools.map(parseDeferredToolCallItem).filter((x): x is DeferredToolCall => x !== null)
		: []

	const fromToolCalls = Array.isArray(r.tool_calls)
		? r.tool_calls.map(parseDeferredToolCallItem).filter((x): x is DeferredToolCall => x !== null)
		: []

	let pending_tools: DeferredToolCall[]
	if (fromPending.length > 0 && fromToolCalls.length > 0) {
		const byId = new Map<string, DeferredToolCall>()
		for (const t of fromPending) {
			byId.set(t.call_id, t)
		}
		for (const t of fromToolCalls) {
			if (!byId.has(t.call_id)) {
				byId.set(t.call_id, t)
			}
		}
		pending_tools = [...byId.values()]
	} else if (fromPending.length > 0) {
		pending_tools = fromPending
	} else {
		pending_tools = fromToolCalls
	}

	const runId = pickNonEmptyString(r.run_id, (r as { runId?: unknown }).runId)
	if (!runId) {
		throw new Error("Cloud Agent: deferred response missing run_id")
	}
	if (runId.length > MAX_DEFERRED_RUN_ID_LENGTH || /[\r\n]/.test(runId)) {
		throw new Error("Cloud Agent: deferred response has invalid run_id")
	}

	const protoVer = r.deferred_protocol_version
	if (protoVer !== undefined && protoVer < MIN_DEFERRED_PROTOCOL_VERSION) {
		throw new Error(
			`Cloud Agent: deferred_protocol_version ${protoVer} is below supported minimum ${MIN_DEFERRED_PROTOCOL_VERSION}`,
		)
	}

	const { tool_calls: _tc, ...rest } = r as DeferredResponse & { tool_calls?: unknown[] }
	return { ...rest, pending_tools, run_id: runId }
}
