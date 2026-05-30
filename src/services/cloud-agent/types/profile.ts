/**
 * Cloud Agent Profile 类型定义
 *
 * 从 @njust-ai/types 重新导出，避免重复定义。
 * 本地补充默认值常量。
 */

export type {
	CloudAgentProfile,
	CloudAgentProtocolType as ProtocolType,
	CloudAgentEndpointConfig as EndpointConfig,
	CloudAgentRestFieldMapping as RestFieldMapping,
	CloudAgentAuthConfig as AuthConfig,
} from "@njust-ai/types"

import type {
	CloudAgentEndpointConfig,
	CloudAgentRestFieldMapping,
	CloudAgentAuthConfig,
} from "@njust-ai/types"

/** 端点默认值 */
export const DEFAULT_ENDPOINTS: Readonly<CloudAgentEndpointConfig> = {
	health: "/health",
	run: "/v1/run",
	deferredStart: "/v1/run/deferred/start",
	deferredResume: "/v1/run/deferred/resume",
	deferredAbort: "/v1/run/deferred/abort",
	compile: "/v1/run/compile",
}

/** 字段映射默认值 */
export const DEFAULT_FIELD_MAPPING: Readonly<Required<CloudAgentRestFieldMapping>> = {
	request: {
		goal: "goal",
		sessionId: "session_id",
		workspacePath: "workspace_path",
		images: "images",
		runId: "run_id",
		toolResults: "tool_results",
	},
	response: {
		runId: "run_id",
		status: "status",
		pendingTools: "pending_tools",
		toolCalls: "tool_calls",
		workspaceOps: "workspace_ops",
		text: "text",
		reasoning: "reasoning",
		logs: "logs",
		ok: "ok",
		memorySummary: "memory_summary",
		tokensIn: "tokens_in",
		tokensOut: "tokens_out",
		cost: "cost",
	},
	statusValues: {
		pending: "pending",
		done: "done",
	},
}

/** 认证默认值 */
export const DEFAULT_AUTH: Readonly<Omit<CloudAgentAuthConfig, "type">> = {
	apiKeyHeader: "X-API-Key",
	deviceTokenSource: "global",
}
