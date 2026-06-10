import type { CloudAgentProfile, RestFieldMapping, EndpointConfig } from "../types/profile"
import { DEFAULT_ENDPOINTS, DEFAULT_FIELD_MAPPING, DEFAULT_AUTH } from "../types/profile"
import type { IProtocolAdapter, UniversalTaskRequest, UniversalTaskResponse, EndpointType } from "./types"
import type { DeferredToolCall } from "../types"
import { normalizeDeferredResponse } from "../normalizeDeferredResponse"
import { getDeviceToken } from "../deviceToken"

/**
 * REST 协议适配器。
 *
 * 处理两种使用场景：
 * 1. NJUST 标准协议 — fieldMapping 使用默认值
 * 2. 自定义 REST API — 通过 Profile.fieldMapping 覆盖特定字段
 */
export class RestProtocolAdapter implements IProtocolAdapter {
	readonly protocolType = "rest"

	private profile!: CloudAgentProfile
	private resolvedMapping!: {
		request: {
			goal: string
			sessionId: string
			workspacePath: string
			images: string
			runId: string
			toolResults: string
		}
		response: Record<string, string>
		statusValues: Record<string, string>
	}
	private resolvedEndpoints!: Required<EndpointConfig>

	initialize(profile: CloudAgentProfile): void {
		this.profile = profile
		this.resolvedMapping = this.mergeFieldMapping(profile.fieldMapping)
		this.resolvedEndpoints = this.mergeEndpoints(profile.endpoints)
	}

	// ─── 连接管理（REST 无需预连接） ────────────────────────────────

	async connect(): Promise<void> {
		// REST 协议无需预连接
	}

	async disconnect(): Promise<void> {
		// REST 协议无需断开连接
	}

	// ─── 请求构建 ──────────────────────────────────────────────────

	buildRequestBody(request: UniversalTaskRequest): Record<string, unknown> {
		const m = this.resolvedMapping.request
		const body: Record<string, unknown> = {
			[m.goal]: request.goal,
			[m.sessionId]: request.sessionId,
		}
		if (request.workspacePath !== undefined) {
			body[m.workspacePath] = request.workspacePath
		}
		if (request.images && request.images.length > 0) {
			body[m.images] = request.images
		}
		if (request.runId !== undefined) {
			body[m.runId] = request.runId
		}
		if (request.toolResults && request.toolResults.length > 0) {
			body[m.toolResults] = request.toolResults
		}
		return body
	}

	// ─── 响应解析（含归一化） ───────────────────────────────────────

	parseResponseBody(data: Record<string, unknown>): UniversalTaskResponse {
		// 使用 normalizeDeferredResponse 进行 pending_tools/tool_calls 归一化
		// 对于 /v1/run 响应（无 run_id），normalizeDeferredResponse 会失败，我们回退到直接解析
		let normalized: ReturnType<typeof normalizeDeferredResponse>
		try {
			normalized = normalizeDeferredResponse(data)
		} catch {
			// 回退：直接读取字段（用于 /v1/run 响应）
			normalized = {
				run_id: "",
				status: "done" as const,
				ok: data.ok as boolean | undefined,
				memory_summary: data.memory_summary as string | undefined,
				logs: data.logs as string[] | undefined,
				tokens_in: data.tokens_in as number | undefined,
				tokens_out: data.tokens_out as number | undefined,
				cost: data.cost as number | undefined,
				text: data.text as string | undefined,
				reasoning: data.reasoning as string | undefined,
				pending_tools: undefined,
				workspace_ops: data.workspace_ops as UnsafeAny,
			}
		}

		return {
			runId: normalized.run_id,
			status: normalized.status,
			pendingTools: (normalized.pending_tools ?? []).map((t: DeferredToolCall) => ({
				callId: t.call_id,
				tool: t.tool,
				arguments: t.arguments,
			})),
			text: normalized.text,
			reasoning: normalized.reasoning,
			logs: normalized.logs,
			ok: normalized.ok,
			memorySummary: normalized.memory_summary,
			tokensIn: normalized.tokens_in,
			tokensOut: normalized.tokens_out,
			cost: normalized.cost,
			raw: data,
		}
	}

	// ─── 端点路径 ──────────────────────────────────────────────────

	getEndpoint(type: EndpointType): string {
		switch (type) {
			case "health":
				return this.resolvedEndpoints.health
			case "run":
				return this.resolvedEndpoints.run
			case "deferredStart":
				return this.resolvedEndpoints.deferredStart
			case "deferredResume":
				return this.resolvedEndpoints.deferredResume
			case "deferredAbort":
				return this.resolvedEndpoints.deferredAbort
			case "compile":
				return this.resolvedEndpoints.compile
		}
	}

	// ─── 认证头 ────────────────────────────────────────────────────

	buildAuthHeaders(): Record<string, string> {
		const auth = this.profile.auth
		const headers: Record<string, string> = {}

		// Device Token
		const dtSource = auth.deviceTokenSource ?? DEFAULT_AUTH.deviceTokenSource ?? "global"
		const dt = dtSource === "profile" && auth.deviceToken ? auth.deviceToken : getDeviceToken()
		if (dt) {
			headers["X-Device-Token"] = dt
		}

		// 认证方式
		switch (auth.type) {
			case "api-key":
				if (auth.apiKey) {
					headers[auth.apiKeyHeader ?? DEFAULT_AUTH.apiKeyHeader ?? "X-API-Key"] = auth.apiKey
				}
				break
			case "bearer":
				if (auth.bearerToken) {
					headers["Authorization"] = `Bearer ${auth.bearerToken}`
				}
				break
			case "basic":
				if (auth.basicUsername && auth.basicPassword) {
					const encoded = Buffer.from(`${auth.basicUsername}:${auth.basicPassword}`).toString("base64")
					headers["Authorization"] = `Basic ${encoded}`
				}
				break
			case "device-token":
				break // 已通过 X-Device-Token 处理
			case "custom":
				if (auth.customHeaders) {
					Object.assign(headers, auth.customHeaders)
				}
				break
		}

		return headers
	}

	// ─── 内部工具 ──────────────────────────────────────────────────

	private mergeFieldMapping(mapping?: RestFieldMapping): {
		request: {
			goal: string
			sessionId: string
			workspacePath: string
			images: string
			runId: string
			toolResults: string
		}
		response: Record<string, string>
		statusValues: Record<string, string>
	} {
		if (!mapping) return DEFAULT_FIELD_MAPPING as never
		return {
			request: { ...DEFAULT_FIELD_MAPPING.request, ...mapping.request } as never,
			response: { ...DEFAULT_FIELD_MAPPING.response, ...mapping.response } as Record<string, string>,
			statusValues: { ...DEFAULT_FIELD_MAPPING.statusValues, ...mapping.statusValues } as Record<string, string>,
		}
	}

	private mergeEndpoints(endpoints?: EndpointConfig): Required<EndpointConfig> {
		if (!endpoints) return DEFAULT_ENDPOINTS as Required<EndpointConfig>
		const merged = { ...DEFAULT_ENDPOINTS, ...endpoints } as Required<EndpointConfig>
		for (const key of Object.keys(merged) as (keyof Required<EndpointConfig>)[]) {
			if (!merged[key]?.trim()) {
				merged[key] = DEFAULT_ENDPOINTS[key]!
			}
		}
		return merged
	}
}
