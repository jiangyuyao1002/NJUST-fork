import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { CloudAgentProfile, AuthConfig as CloudAgentAuthConfig } from "../types/profile"
import type { DeferredToolCall } from "../types"
import { logger } from "../../../shared/logger"
import { getErrorMessage } from "../../../shared/error-utils"
import type { IProtocolAdapter, UniversalTaskRequest, UniversalTaskResponse, EndpointType } from "./types"

export const MCP_TOOLS = {
	SUBMIT_TASK: "submit_task",
	COMPILE: "compile",
} as const

export interface McpCallbackHandler {
	onText?: (content: string) => Promise<void>
	onReasoning?: (content: string) => Promise<void>
	onDone?: (summary: string) => Promise<void>
	onError?: (message: string) => Promise<void>
	// SECURITY: onToolExecute removed — cloudagent/executeTool allowed arbitrary
	// remote tool execution with no whitelist. See integrated code review P0-12.
}

/**
 * MCP 协议适配器。
 *
 * 通过 Model Context Protocol (Streamable HTTP) 与远程 Agent 服务器通信。
 * endpoint 固定为 /mcp，由 StreamableHTTPClientTransport 管理。
 *
 * **限制**：
 * - `submit_task` 工具应当**一次性返回结果**（服务器端内聚 deferred 逻辑）。
 * - 服务器通过 `sendRequest("cloudagent/executeTool", ...)` 请求客户端执行
 *   工具的模式当前未被 `CloudAgentOrchestrator` 消费（`onToolExecute` 返回错误）。
 * - 如需完整支持服务器端工具调用，需实现 MCP 会话管理与工具执行桥接。
 */
export class McpProtocolAdapter implements IProtocolAdapter {
	readonly protocolType = "mcp"

	private client!: Client
	private transport!: StreamableHTTPClientTransport
	private profile!: CloudAgentProfile
	private connected = false
	private initialized = false
	private callbackHandler?: McpCallbackHandler

	setCallbackHandler(handler: McpCallbackHandler): void {
		this.callbackHandler = handler
	}

	/** 用 Profile 初始化适配器（创建 transport 和 client）。 */
	initialize(profile: CloudAgentProfile): void {
		this.profile = profile
		this.initialized = true

		const authHeaders = this.buildMcpAuthHeaders(profile.auth)

		this.transport = new StreamableHTTPClientTransport(new URL(`${profile.serverUrl}/mcp`), {
			requestInit: {
				headers: authHeaders,
			},
		})

		this.client = new Client({ name: "njust-ai", version: "1.0.0" }, { capabilities: {} })
	}

	/** MCP 握手；连接后自动注册回调 handler。 */
	async connect(): Promise<void> {
		if (!this.initialized) {
			throw new Error("McpProtocolAdapter: initialize() must be called before connect()")
		}
		if (this.connected) return

		await this.client.connect(this.transport)
		const capabilities = this.client.getServerCapabilities()

		if (!capabilities?.tools) {
			throw new Error("MCP server does not support tools capability")
		}

		this.connected = true
		this.registerCallbackHandlers()
	}

	private registerCallbackHandlers(): void {
		if (!this.callbackHandler) return

		const client = this.client

		client.setNotificationHandler(
			{ method: "notifications/cloudagent/text" } as UnsafeAny,
			async (notification: UnsafeAny) => {
				const content = (notification as { params?: { content?: string } })?.params?.content
				if (content && this.callbackHandler?.onText) {
					try {
						await this.callbackHandler.onText(content)
					} catch (e) {
						logger.warn("McpProtocolAdapter", `onText handler error: ${getErrorMessage(e)}`)
					}
				}
			},
		)

		client.setNotificationHandler(
			{ method: "notifications/cloudagent/reasoning" } as UnsafeAny,
			async (notification: UnsafeAny) => {
				const content = (notification as { params?: { content?: string } })?.params?.content
				if (content && this.callbackHandler?.onReasoning) {
					try {
						await this.callbackHandler.onReasoning(content)
					} catch (e) {
						logger.warn("McpProtocolAdapter", `onReasoning handler error: ${getErrorMessage(e)}`)
					}
				}
			},
		)

		client.setNotificationHandler(
			{ method: "notifications/cloudagent/done" } as UnsafeAny,
			async (notification: UnsafeAny) => {
				const summary = (notification as { params?: { summary?: string } })?.params?.summary
				if (summary && this.callbackHandler?.onDone) {
					try {
						await this.callbackHandler.onDone(summary)
					} catch (e) {
						logger.warn("McpProtocolAdapter", `onDone handler error: ${getErrorMessage(e)}`)
					}
				}
			},
		)

		// SECURITY: cloudagent/executeTool handler removed (P0-12).
		// Previously allowed remote MCP servers to trigger arbitrary tool execution
		// on the client with no whitelist. Re-enable only with strict tool allowlist.
	}

	/** 关闭 MCP 连接。 */
	async disconnect(): Promise<void> {
		if (this.connected) {
			await this.client.close()
			this.connected = false
		}
	}

	// ─── 请求构建 ──────────────────────────────────────────────────

	/** 同时输出 snake_case 和 camelCase，兼容不同服务器风格。 */
	buildRequestBody(request: UniversalTaskRequest): Record<string, unknown> {
		return {
			// snake_case（REST 风格）
			goal: request.goal,
			session_id: request.sessionId,
			workspace_path: request.workspacePath,
			images: request.images,
			run_id: request.runId,
			tool_results: request.toolResults,

			// camelCase（MCP mock 服务器风格）
			message: request.goal,
			sessionId: request.sessionId,
			workspacePath: request.workspacePath,
		}
	}

	// ─── 响应解析 ──────────────────────────────────────────────────

	/** 将 MCP ToolResult 解析为通用响应格式。 */
	parseResponseBody(data: Record<string, unknown>): UniversalTaskResponse {
		const parsed = this.parseMcpContent(data)

		const rawTools = parsed.pending_tools || parsed.tool_calls
		const safeTools: DeferredToolCall[] = Array.isArray(rawTools) ? rawTools : []

		return {
			runId: (parsed.run_id as string) || "",
			status: (parsed.status as "pending" | "done") || "done",
			pendingTools: safeTools.map((t) => ({
				callId: t.call_id,
				tool: t.tool,
				arguments: t.arguments,
			})),
			workspaceOps: parsed.workspace_ops as UnsafeAny,
			text: parsed.text as string,
			reasoning: parsed.reasoning as string,
			logs: parsed.logs as string[],
			ok: parsed.ok as boolean,
			memorySummary: parsed.memory_summary as string,
			tokensIn: parsed.tokens_in as number,
			tokensOut: parsed.tokens_out as number,
			cost: parsed.cost as number,
			raw: data,
		}
	}

	// ─── 端点与认证 ────────────────────────────────────────────────

	/**
	 * MCP 使用统一 endpoint（/mcp），无需按类型区分路径。
	 * 始终返回空字符串；CloudAgentClient 会直接使用 serverUrl。
	 */
	getEndpoint(_type: EndpointType): string {
		return ""
	}

	buildAuthHeaders(): Record<string, string> {
		return {}
	}

	// ─── MCP 工具调用 ──────────────────────────────────────────────

	/** 调用 MCP 工具并返回解析后的通用响应。自动连接。 */
	async callTool(name: string, args: Record<string, unknown>): Promise<UniversalTaskResponse> {
		if (!this.connected) {
			await this.connect()
		}

		const result = await this.client.callTool({
			name,
			arguments: args,
		})

		return this.parseResponseBody(result as Record<string, unknown>)
	}

	// ─── Compile 响应解析 ──────────────────────────────────────────

	/** 从 MCP 响应中提取 compile 结果（{ success, output }）。 */
	parseCompileResponse(data: Record<string, unknown>): { success: boolean; output: string } {
		const parsed = this.parseMcpContent(data)
		return {
			success: (parsed.success as boolean) ?? false,
			output: (parsed.output as string) ?? "",
		}
	}

	// ─── 内部工具 ──────────────────────────────────────────────────

	/** 从 MCP ToolResult 的 content 数组中提取并解析 JSON 文本。 */
	parseMcpContent(data: Record<string, unknown>): Record<string, unknown> {
		const content = data.content as Array<{ type: string; text?: string }> | undefined

		if (!content || !Array.isArray(content)) {
			logger.warn("McpProtocolAdapter", "MCP response missing or invalid content array")
			return data
		}

		const textContent = content.find((c) => c.type === "text")?.text

		if (!textContent) {
			logger.warn("McpProtocolAdapter", "MCP response content array has no text entry")
			return data
		}

		try {
			return JSON.parse(textContent)
		} catch (e) {
			logger.warn("McpProtocolAdapter", `Failed to parse MCP content as JSON: ${getErrorMessage(e)}`)
			return data
		}
	}

	private buildMcpAuthHeaders(auth: CloudAgentAuthConfig): Record<string, string> {
		const headers: Record<string, string> = {}

		switch (auth.type) {
			case "bearer":
				if (auth.bearerToken) {
					headers["Authorization"] = `Bearer ${auth.bearerToken}`
				} else {
					logger.warn("McpProtocolAdapter", "Bearer auth configured but bearerToken is empty")
				}
				break
			case "api-key":
				if (auth.apiKey) {
					headers[auth.apiKeyHeader || "X-API-Key"] = auth.apiKey
				} else {
					logger.warn("McpProtocolAdapter", "API key auth configured but apiKey is empty")
				}
				break
			case "custom":
				if (auth.customHeaders) {
					Object.assign(headers, auth.customHeaders)
				}
				break
		}

		return headers
	}
}
