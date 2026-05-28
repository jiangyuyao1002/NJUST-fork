import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import type { CloudAgentProfile, AuthConfig as CloudAgentAuthConfig } from "../types/profile"
import type { DeferredToolCall } from "../types"
import type {
	IProtocolAdapter,
	UniversalTaskRequest,
	UniversalTaskResponse,
	EndpointType,
} from "./types"

/**
 * MCP 协议适配器。
 *
 * 通过 Model Context Protocol 与远程 Agent 服务器通信。
 * 使用 Streamable HTTP Transport，endpoint 为 /mcp。
 */
export class McpProtocolAdapter implements IProtocolAdapter {
	readonly protocolType = "mcp"

	private client!: Client
	private transport!: StreamableHTTPClientTransport
	private profile!: CloudAgentProfile
	private connected = false

	initialize(profile: CloudAgentProfile): void {
		this.profile = profile

		// 构建认证 headers
		const authHeaders = this.buildMcpAuthHeaders(profile.auth)

		// 创建 transport，endpoint 为 /mcp
		this.transport = new StreamableHTTPClientTransport(
			new URL(`${profile.serverUrl}/mcp`),
			{
				requestInit: {
					headers: authHeaders,
				},
			},
		)

		// 与项目风格一致：使用 { capabilities: {} }
		this.client = new Client(
			{ name: "njust-ai-cj", version: "1.0.0" },
			{ capabilities: {} },
		)
	}

	async connect(): Promise<void> {
		if (this.connected) return

		// MCP 握手（等效于健康检查）
		await this.client.connect(this.transport)
		const capabilities = this.client.getServerCapabilities()

		if (!capabilities?.tools) {
			throw new Error("MCP server does not support tools capability")
		}

		this.connected = true
	}

	async disconnect(): Promise<void> {
		if (this.connected) {
			await this.client.close()
			this.connected = false
		}
	}

	// ─── 请求构建 ──────────────────────────────────────────────────

	buildRequestBody(request: UniversalTaskRequest): Record<string, unknown> {
		// 同时输出 snake_case 和 camelCase，兼容不同服务器
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

	parseResponseBody(data: Record<string, unknown>): UniversalTaskResponse {
		const parsed = this.parseMcpContent(data)

		// 归一化响应字段
		return {
			runId: (parsed.run_id as string) || "",
			status: (parsed.status as "pending" | "done") || "done",
			pendingTools: ((parsed.pending_tools || parsed.tool_calls) as DeferredToolCall[] || []).map((t) => ({
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

	getEndpoint(_type: EndpointType): string {
		// MCP 使用统一 endpoint，返回空字符串
		// CloudAgentClient 会使用 serverUrl 作为完整 URL
		return ""
	}

	buildAuthHeaders(): Record<string, string> {
		// MCP 通过 transport headers 传递认证（在 initialize 中配置）
		return {}
	}

	// ─── MCP 工具调用 ──────────────────────────────────────────────

	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<UniversalTaskResponse> {
		if (!this.connected) {
			await this.connect()
		}

		const result = await this.client.callTool({
			name,
			arguments: args,
		})

		return this.parseResponseBody(result as Record<string, unknown>)
	}

	// ─── 内部工具 ──────────────────────────────────────────────────

	/**
	 * 从 MCP ToolResult 中提取并解析 JSON 内容。
	 * 统一处理 content[0].text → JSON.parse 的重复逻辑。
	 */
	private parseMcpContent(data: Record<string, unknown>): Record<string, unknown> {
		const content = data.content as Array<{ type: string; text?: string }> | undefined
		const textContent = content?.find((c) => c.type === "text")?.text

		try {
			return textContent ? JSON.parse(textContent) : data
		} catch {
			return data
		}
	}

	private buildMcpAuthHeaders(auth: CloudAgentAuthConfig): Record<string, string> {
		const headers: Record<string, string> = {}

		switch (auth.type) {
			case "bearer":
				if (auth.bearerToken) {
					headers["Authorization"] = `Bearer ${auth.bearerToken}`
				}
				break
			case "api-key":
				if (auth.apiKey) {
					headers[auth.apiKeyHeader || "X-API-Key"] = auth.apiKey
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
