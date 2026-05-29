# AGENTS.md

This file provides guidance to agents when working with code in this repository.

- Settings View Pattern: When working on `SettingsView`, inputs must bind to the local `cachedState`, NOT the live `useExtensionState()`. The `cachedState` acts as a buffer for user edits, isolating them from the `ContextProxy` source-of-truth until the user explicitly clicks "Save". Wiring inputs directly to the live state causes race conditions.

- Cloud Agent local mock: Run `node src/test-cloud-agent-mock.mjs` from the repo root, set `njust-ai-cj.cloudAgent.serverUrl` to `http://127.0.0.1:4000`, and use Cloud Agent mode in the extension. The mock exposes REST `GET /health`, `POST /v1/run`, `POST /v1/run/deferred/start|resume|abort`, `POST /v1/run/compile`, and optional MCP at `POST /mcp`. Optional mock API key env: `CLOUD_AGENT_MOCK_API_KEY`.

- Cloud Agent deferred execution protocol: When `njust-ai-cj.cloudAgent.deferredProtocol` is `true` (**default**), the extension uses `POST /v1/run/deferred/start` and `POST /v1/run/deferred/resume` instead of single-shot `/v1/run`. The server returns `status: "pending"` with `pending_tools` (MCP-style `{ call_id, tool, arguments }`) and optional `workspace_ops`. The extension executes tool calls locally (read_file, write_file, apply_diff, list_files, search_files, execute_command), collects results as `{ call_id, content, is_error }`, and POSTs them back via `/v1/run/deferred/resume`. This loops until `status == "done"` or 50 iterations. Set `deferredProtocol` to `false` to fall back to legacy `/v1/run`. Session cleanup: `POST /v1/run/deferred/abort` (`{ session_id, run_id? }`, idempotent 200) notifies the server when a deferred run ends or errors; older servers without this route return 404 and are ignored.

- Cloud Agent compile feedback loop: After workspace_ops are applied, the extension optionally calls `POST /v1/run/compile` (`{ session_id, workspace_path? }`) to compile on the server. If compilation fails, the extension sends compile errors back to `POST /v1/run` for the agent to fix, then re-compiles. This loops until compilation passes or `cloudAgent.compileLoop.maxRetries` (default 3) is reached. Controlled by `njust-ai-cj.cloudAgent.compileLoop.enabled` (default **true**). Server must expose `POST /v1/run/compile` returning `{ success: boolean, output: string }`.

- Cloud Agent `POST /v1/run` optional `workspace_ops`: The JSON body may include `workspace_ops: { version?: 1, operations: [...] }`. Each operation is a discriminated object: `{ "op": "write_file", "path": "<relative>", "content": "<utf-8>" }` or `{ "op": "apply_diff", "path": "<relative>", "diff": "<SEARCH/REPLACE diff>" }` (same format as the built-in MCP `apply_diff` tool). Limits: at most 50 operations; path max 4096 chars; `content`/`diff` max 1,000,000 chars each. The extension applies these when `njust-ai-cj.cloudAgent.applyRemoteWorkspaceOps` is `true` (**default**; set `false` to ignore); paths are constrained to the current workspace. Invalid `workspace_ops` is logged and ignored (the rest of the response still applies). When `njust-ai-cj.cloudAgent.confirmRemoteWorkspaceOps` is `true` (default), each operation is shown in the chat as a normal tool approval (approve/reject) before it runs; set it to `false` to apply all operations in one batch without per-step UI.

- Cangjie LSP smoke (needs local SDK): Extension Host with `CANGJIE_HOME` or `njust-ai-cj.cangjieLsp.serverPath` set; open Output channel **Cangjie Language Server** and confirm no startup errors; status bar **仓颉 LSP** idle then running after first `.cj` open (or immediate if `.cj` already open). With no `.cj` open at activate, confirm log line deferring startup, then open a `.cj` and confirm server starts. Run **Cangjie: Restart Language Server** and confirm recovery. Multi-root: LSP `workspaceFolder` / `cjpm` root is the **first** workspace folder that contains `cjpm.toml`—verify diagnostics match that project when using multiple roots. If the LSP binary is missing or `client.start` fails, cjfmt/cjlint/compile-guard should still activate after that attempt (one-shot `onCangjieActivated`).

- Cangjie LSP vs local providers: The extension registers both the language client (completion, hover, diagnostics, etc.) and file-based providers (`CangjieSymbolIndex` fallbacks for definition/reference/rename/symbols). VS Code merges results where applicable; duplicates or ordering differences are possible—validate go-to-definition and outline on a real project if behavior looks odd.

- Cangjie toolset smoke (local SDK): With **empty** `njust-ai-cj.cangjieTools.*` paths and unset `cangjieLsp.cjcPath`, verify save-time `cjfmt`, `cjlint` diagnostics, `cjpm` tasks/commands, Run Code on `.cj` (project with `cjpm.toml` and single-file), **Cangjie: Profile** (`cjprof`), and status bar SDK version (via `cjc --version`). Then set **wrong** explicit paths and confirm failures are visible (no silent fallback—`resolveCangjieToolPath` returns undefined when a configured file is missing). Set only `njust-ai-cj.cangjieLsp.cjcPath`; macro expand, status bar version, and Run Code should all use that compiler.

- Cangjie `CANGJIE_HOME` vs `cangjieLsp.serverPath`: `CangjieLspClient` can infer SDK home from `serverPath`; `cangjieToolUtils.detectCangjieHome()` does **not** read `serverPath`—only `CANGJIE_HOME`, well-known install dirs, then tools fall back to PATH. If you rely solely on `serverPath` without `CANGJIE_HOME`, the LSP may start while CLI tools (`cjfmt`, `cjpm`, etc.) still fail unless their executables are on PATH or you set per-tool paths.

- vitest `vi.mock` path trap: When the test file sits in a `__tests__/` subdirectory (e.g. `src/core/task/__tests__/`), `vi.mock` paths MUST be calculated from THAT directory, NOT from the adjacent source directory. Vite import resolution may walk up parent directories when a path doesn't resolve, but `vi.mock` does NOT share this fallback. Example: from `src/core/task/__tests__/`, `../errors/apiErrorClassifier` resolves to `src/core/task/errors/` (wrong, doesn't exist), but the correct path is `../../errors/apiErrorClassifier` (→ `src/core/errors/`). Always verify module paths resolve to the same absolute file as the source file's import.

## Cloud Agent MCP 协议

- **协议选择**：`AdapterFactory` 根据 `profile.protocolType` 创建适配器。`"mcp"` → `McpProtocolAdapter`（`@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`）；`"rest"`（或未知值）→ `RestProtocolAdapter`。未知类型会 fallback 到 REST 并在日志中打 `warning`。

- **强制 Legacy 模式**：MCP **不走 deferred 协议**。`CloudAgentOrchestrator.run()` 中 `profile.protocolType !== "mcp"` 时才进入 `runDeferredLoop`。原因是 MCP 的 `submit_task` 工具在**服务端内聚**了 deferred 逻辑（start/resume 循环在服务器内部完成），客户端只需一次性调用并等待最终响应。

- **Callback Handler**：`McpProtocolAdapter` 在 `connect()` 后自动注册 4 类 notification + 1 类 request handler：
  - `notifications/cloudagent/text` → `onText`
  - `notifications/cloudagent/reasoning` → `onReasoning`
  - `notifications/cloudagent/done` → `onDone`
  - `cloudagent/executeTool` → `onToolExecute`（当前默认返回错误，未实现本地工具桥接）
  `CloudAgentClient` 在构造函数中通过 `setCallbackHandler()` 注入。所有 handler 均包裹 try-catch，错误只打 `warn` 不抛异常。

- **连接生命周期**：同步 `initialize()` → 异步 `connect()`（MCP 握手）→ `callTool()` → `disconnect()`。`connect()` 集成 `AbortSignal` timeout（`Promise.race`）。`CloudAgentClient.withMcpAdapter()` 包装调用：异常时自动 `disconnect()`，成功路径的释放由 `CloudAgentOrchestrator.runLegacy()` 的 `finally` 块负责。

- **认证**：`buildMcpAuthHeaders()` 在 `initialize()` 时将认证头注入 transport 的 `requestInit.headers`。支持 `bearer` / `api-key` / `custom` 三种 `auth.type`。空 token 时打 `warning`（不抛异常）。

- **Compile 反馈闭环**：MCP 模式下 `compile` 同样通过 `callTool(MCP_TOOLS.COMPILE)` 调用。`parseCompileResponse()` 默认 `success: false`（安全失败，不静默吞错）。其余 compile 反馈循环逻辑与 REST 相同。

## 通用约束

- **删除文件前必须用户确认**：Agent 在执行任何 `git rm`、手动删除文件、或通过代码逻辑删除用户工作区文件的操作前，**必须先向用户展示待删除文件列表并获得明确确认**（如用户回复 "确认删除" 或选择 "是"）。禁止在未经用户许可的情况下静默删除任何文件。此约束适用于代码提交、重构、清理等所有场景。
- **提交代码前必须用户确认**：Agent 在执行 `git commit` 或等效提交操作前，**必须先向用户展示本次提交的变更摘要（受影响的文件列表和关键修改点）并获得明确确认**。禁止在未经用户许可的情况下静默提交任何代码。
