# MCP 适配器技术调研

## 目标

为 Cloud Agent Profile 系统添加 MCP 协议支持，使扩展能够通过 Model Context Protocol (MCP) 与远程 Agent 服务器通信。

## 1. MCP SDK 选择

### 推荐：@modelcontextprotocol/sdk

- **版本**: 1.0.0+（2024年11月 GA 发布）
- **NPM**: `@modelcontextprotocol/sdk`
- **GitHub**: modelcontextprotocol/typescript-sdk

### 核心 API

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const client = new Client({ name: "roo-code-extension", version: "1.0.0" })
const transport = new StreamableHTTPClientTransport(new URL("http://server/mcp"))
await client.connect(transport)

// 能力协商
const capabilities = await client.getServerCapabilities()
const tools = await client.listTools()
const resources = await client.listResources()
```

### 备选：自研轻量客户端

如果 SDK 依赖过重（约 200KB+），可考虑自研：
- 仅实现 `initialize`、`tools/list`、`tools/call` 三个方法
- 自行处理 JSON-RPC 2.0 消息格式
- 降低 bundle 体积（估计减少 150KB+）

**建议**：先使用官方 SDK 快速验证，如体积问题严重再考虑自研。

## 2. Transport 方式对比

| 方式 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **Streamable HTTP** | 现代 MCP 服务器 | 支持 SSE 流式响应、自动重连、标准 HTTP | 需要服务器支持 |
| **SSE (Server-Sent Events)** | 传统实现 | 单向流式、简单 | 不支持客户端→服务器流式 |
| **stdio** | 本地子进程 | 安全隔离、无网络依赖 | 仅限本地 |

### 推荐：Streamable HTTP

Cloud Agent 场景最适合 Streamable HTTP：
- 与现有 REST 架构一致
- 支持流式响应（SSE 流）
- 天然支持 HTTP 认证头（与我们现有 auth 机制兼容）
- 可通过 nginx/ingress 统一网关

### 端点设计

```
POST /mcp/v1/initialize     # 能力协商
POST /mcp/v1/tools/list     # 获取工具列表
POST /mcp/v1/tools/call     # 调用工具
POST /mcp/v1/resources/list # 获取资源列表
```

## 3. 能力协商

### 标准能力

MCP 1.0 定义的能力：
- `tools`: 服务器提供可调用工具
- `resources`: 服务器提供可读资源
- `prompts`: 服务器提供提示模板
- `logging`: 服务器可发送日志
- `sampling`: 服务器可请求 LLM 采样

### Cloud Agent 场景映射

```
Cloud Agent REST API          → MCP 能力
POST /v1/run                  → tools/call (submit_task)
POST /v1/run/deferred/start   → tools/call (deferred_start)
POST /v1/run/deferred/resume  → tools/call (deferred_resume)
workspace_ops                 → resources (write_file, apply_diff)
```

### 协商流程

```
1. Client → Server: initialize (client capabilities)
2. Server → Client: initialize response (server capabilities)
3. Client → Server: initialized (确认)
4. Client → Server: tools/list (获取可用工具)
```

## 4. 工具映射

### submit_task → callTool

**MCP 工具定义**（服务器提供）：
```json
{
  "name": "submit_task",
  "description": "Submit a coding task to the cloud agent",
  "inputSchema": {
    "type": "object",
    "properties": {
      "goal": { "type": "string" },
      "session_id": { "type": "string" },
      "workspace_path": { "type": "string" },
      "images": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["goal", "session_id"]
  }
}
```

**调用方式**：
```typescript
const result = await client.callTool({
  name: "submit_task",
  arguments: {
    goal: "Implement feature X",
    session_id: "sid-123",
    workspace_path: "/workspace"
  }
})
```

### workspace_ops → resources

workspace_ops 更适合映射为 MCP resources：
- `write_file` → `resource://workspace/file.txt` (create/update)
- `apply_diff` → 通过 `resources/read` 读取后本地 apply

## 5. 与现有 IProtocolAdapter 接口的兼容性

### 当前接口

```typescript
interface IProtocolAdapter {
  readonly protocolType: string
  initialize(profile: CloudAgentProfile): void
  buildRequestBody(request: UniversalTaskRequest): Record<string, unknown>
  parseResponseBody(data: Record<string, unknown>): UniversalTaskResponse
  getEndpoint(type: EndpointType): string
  buildAuthHeaders(): Record<string, string>
}
```

### 适配方案

MCP 适配器需要扩展接口或内部封装：

```typescript
class McpProtocolAdapter implements IProtocolAdapter {
  readonly protocolType = "mcp"
  private client!: Client
  private transport!: StreamableHTTPClientTransport

  initialize(profile: CloudAgentProfile): void {
    this.transport = new StreamableHTTPClientTransport(new URL(profile.serverUrl))
    this.client = new Client({ name: "roo-code", version: "1.0.0" })
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport)
    // 能力协商
    const caps = await this.client.getServerCapabilities()
    this.supportsTools = !!caps.tools
  }

  buildRequestBody(request: UniversalTaskRequest): Record<string, unknown> {
    // MCP 使用 tools/call，不需要构建 HTTP body
    // 返回的参数供 callTool 使用
    return {
      goal: request.goal,
      session_id: request.sessionId,
      workspace_path: request.workspacePath,
      images: request.images
    }
  }

  async submitTask(request: UniversalTaskRequest): Promise<UniversalTaskResponse> {
    const result = await this.client.callTool({
      name: "submit_task",
      arguments: this.buildRequestBody(request)
    })
    return this.parseToolResult(result)
  }

  parseResponseBody(data: Record<string, unknown>): UniversalTaskResponse {
    // 将 MCP ToolResult 转换为 UniversalTaskResponse
    return {
      runId: data.run_id as string,
      status: data.status as "pending" | "done",
      pendingTools: (data.pending_tools as any[] ?? []).map(...),
      text: data.text as string,
      memorySummary: data.memory_summary as string,
      // ...
    }
  }
}
```

### 接口兼容性分析

| 当前接口方法 | MCP 支持 | 备注 |
|-------------|---------|------|
| `buildRequestBody` | ⚠️ 语义不同 | MCP 使用 tools/call，非 HTTP POST body |
| `parseResponseBody` | ✅ 支持 | 转换 MCP ToolResult |
| `getEndpoint` | ❌ 不适用 | MCP 统一 endpoint |
| `buildAuthHeaders` | ✅ 支持 | 通过 transport headers 传递 |

**结论**：IProtocolAdapter 接口需要少量调整以支持 MCP：
1. 添加可选的 `connect()` 方法（MCP 需要初始化协商）
2. `getEndpoint` 对 MCP 无意义，可返回空字符串或统一路径
3. `buildRequestBody` 保留但语义变为 "构建 tool arguments"

## 6. 实施建议

### Phase 1：调研验证（本期）
- [x] 输出本文档
- [ ] 搭建 MCP mock server（基于 @modelcontextprotocol/sdk/server）
- [ ] 验证工具调用流程
- [ ] 测量 bundle 体积影响

### Phase 2：最小实现（下期）
- [ ] 实现 `McpProtocolAdapter`
- [ ] 添加 `protocolType: "mcp"` 到 Profile 类型
- [ ] 支持 `tools/call` 和 `resources/list`
- [ ] 单元测试覆盖

### Phase 3：完整支持（远期）
- [ ] 支持 deferred protocol（通过 MCP streaming）
- [ ] 支持 prompts/sampling（如服务器提供）
- [ ] 支持 multiple servers（MCP hub）

## 7. 风险与注意事项

1. **Bundle 体积**：@modelcontextprotocol/sdk 可能增加 200KB+ bundle 体积，需要评估
2. **向后兼容**：MCP 1.0 刚 GA，API 可能仍有变动
3. **服务器支持**：需要 Cloud Agent 服务器端实现 MCP 协议
4. **认证差异**：MCP 标准使用 OAuth2，与现有 api-key/bearer 机制不同
5. **错误处理**：MCP 错误码体系与 HTTP 状态码不同，需要转换层

## 参考资源

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Introduction](https://modelcontextprotocol.io/introduction)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
