# 架构优化实施手册 — 附录

> 本文档是 [`architecture-optimization-plan.md`](./architecture-optimization-plan.md) 的补充，
> 包含每个 Phase 的具体代码示例、迁移脚本和检查清单。

---

## Phase 1 附录：品牌类型 + Zod 验证

### 1.1 品牌类型完整实现

```ts
// 新建: src/shared/branded-types.ts
import { v7 as uuidv7 } from "uuid"

declare const TaskIDBrand: unique symbol
declare const MessageIDBrand: unique symbol
declare const ToolCallIDBrand: unique symbol

export type TaskID = string & { readonly [TaskIDBrand]: never }
export type MessageID = string & { readonly [MessageIDBrand]: never }
export type ToolCallID = string & { readonly [ToolCallIDBrand]: never }

// 工厂函数
const createFactory = <T extends string>() => ({
  make: (value?: string) => (value ?? uuidv7()) as T,
  from: (value: string) => value as T,
  isType: (value: unknown): value is T => typeof value === "string",
})

export const TaskID = createFactory<TaskID>()
export const MessageID = createFactory<MessageID>()
export const ToolCallID = createFactory<ToolCallID>()
```

### 1.2 ITaskExecutorHost 改动对照

**BEFORE** (`src/core/task/interfaces/ITaskExecutorHost.ts`):

```ts
export interface TaskExecutorDelegatesHost {
  streamProcessor: {
    backoffAndAnnounce(retryAttempt: number, error: UnsafeAny): Promise<void>
    buildCleanConversationHistory(messages: ApiMessage[]): UnsafeAny[]
    getCurrentProfileId(state: UnsafeAny): string
    getFilesReadByRooSafely(context: string): Promise<string[] | undefined>
  }
  errorRecovery: {
    handleApiError(error: UnsafeAny, retryAttempt: number): Promise<{ action: string; nextAttempt: number }>
    recordCompactFailure(error: UnsafeAny): Promise<void>
  }
  autoApprovalHandler: {
    checkAutoApprovalLimits(
      state: UnsafeAny,
      messages: ClineMessage[],
      askFn: (type: ClineAsk, data?: string) => Promise<...>,
    ): Promise<{ shouldProceed: boolean }>
  }
}
```

**AFTER**:

```ts
import type { ExtensionState } from "@njust-ai-cj/types"

export interface TaskExecutorDelegatesHost {
  streamProcessor: {
    backoffAndAnnounce(retryAttempt: number, error: Error): Promise<void>
    buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.Messages.MessageParam[]
    getCurrentProfileId(state: ExtensionState): string
    getFilesReadByRooSafely(context: string): Promise<string[] | undefined>
  }
  errorRecovery: {
    handleApiError(error: Error, retryAttempt: number): Promise<{ action: string; nextAttempt: number }>
    recordCompactFailure(error: Error): Promise<void>
  }
  autoApprovalHandler: {
    checkAutoApprovalLimits(
      state: ExtensionState,
      messages: ClineMessage[],
      askFn: (type: ClineAsk, data?: string) => Promise<...>,
    ): Promise<{ shouldProceed: boolean }>
  }
}
```

### 1.3 UnsafeAny 消除检查清单

逐一确认以下文件修改完毕：

- [ ] `src/core/task/interfaces/ITaskExecutorHost.ts` — 移除 12 处 UnsafeAny
- [ ] `src/core/task/interfaces/ITaskHost.ts` — 移除返回值中的 UnsafeAny
- [ ] `src/core/task/TaskExecutor.ts` — 移除 `h as UnsafeAny`、`error as UnsafeAny` 等 11 处
- [ ] `src/core/task/TaskStreamProcessor.ts` — 移除 `state as UnsafeAny` 等 12 处
- [ ] `src/core/task/TaskLifecycleHandler.ts` — 移除接口 UnsafeAny（第 10 处）
- [ ] `src/core/task/TaskMessageManager.ts` — 移除内部类型体操（第 11 处）
- [ ] `src/core/task/Task.ts` — 移除 `this as UnsafeAny as TaskMessageContext`（第 2265 行）
- [ ] `src/core/context-management/index.ts` — 移除 `rooIgnoreController as UnsafeAny`

验证命令：

```bash
# 在整个 task/ 目录中搜索残余的 UnsafeAny
grep -rn "UnsafeAny" src/core/task/ --include="*.ts" | grep -v "node_modules" | grep -v ".spec.ts"
# 目标: 输出为空（或仅剩测试文件）
```

---

## Phase 2 附录：事件系统迁移

### 2.1 旧 EventEmitter 到新 TypedTaskEventBus 的迁移

**删除模式**: `Task extends EventEmitter`

```ts
// BEFORE: Task.ts
export class Task extends EventEmitter<TaskEvents> {
  // ...
  this.emit(NJUST_AI_CJEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
}

// AFTER: Task.ts
import { taskEventBus } from "../events/TaskEventBus"

export class Task {
  // 不再 extends EventEmitter
  // ...
  private notifyTokenUsage(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
    taskEventBus.emit("task:tokens-updated", {
      taskId: this.taskId as TaskID,
      usage: tokenUsage,
    })
  }
}
```

### 2.2 事件迁移对照表

| 旧 `NJUST_AI_CJEventName` 名 | 旧 `this.emit(...)` 参数 | 新 `taskEventBus.emit()` 事件名 |
|---|---|---|
| `TaskTokenUsageUpdated` | `(taskId, tokenUsage, toolUsage)` | `"task:tokens-updated"` |
| `TaskUserMessage` | `(taskId)` | `"task:user-message"` |
| `QueuedMessagesUpdated` | `(taskId, messages)` | `"task:queued-messages-updated"` |
| *(TaskLifecycle)* | 散落在各处 | `"task:started"` / `"task:completed"` / `"task:failed"` |

### 2.3 WebView 桥接适配器

```ts
// 新建: src/core/events/WebviewEventBridge.ts
import { taskEventBus, type TypedTaskEventBus } from "./TaskEventBus"
import type { ExtensionMessage } from "@njust-ai-cj/types"

export interface DisposableLike { dispose(): void }

export function bridgeTaskEventsToWebview(
  bus: TypedTaskEventBus,
  postMessage: (msg: ExtensionMessage) => Promise<void>,
): DisposableLike {
  const disposables: Array<{ dispose(): void }> = []

  disposables.push(bus.on("task:started", (p) => {
    void postMessage({ type: "taskStarted", text: p.taskId })
  }))

  disposables.push(bus.on("task:completed", (p) => {
    void postMessage({ type: "taskCompleted", text: p.taskId })
  }))

  disposables.push(bus.on("task:tokens-updated", (p) => {
    void postMessage({
      type: "taskTokenUsage",
      text: p.taskId,
      tokens: p.usage,
    } as unknown as ExtensionMessage)
  }))

  disposables.push(bus.on("task:tool-executing", (p) => {
    void postMessage({
      type: "toolProgress",
      tool: p.tool,
      status: "executing",
    } as unknown as ExtensionMessage)
  }))

  return {
    dispose: () => disposables.forEach((d) => d.dispose()),
  }
}
```

---

## Phase 3 附录：Task Host 接口完整定义

### 3.1 新增 Host 接口

```ts
// 新建: src/core/task/interfaces/IHostContracts.ts
import type { Anthropic } from "@anthropic-ai/sdk"
import type {
  ClineSay, ClineAsk, ContextCondense, ContextTruncation,
  ProviderSettings, ToolProgressStatus, ToolUsage, TokenUsage,
  ToolName,
} from "@njust-ai-cj/types"
import type { TaskID, MessageID, ToolCallID } from "../../../shared/branded-types"
import type { ClineMessage } from "../../../shared/WebviewMessage"
import type { ApiMessage } from "../../task-persistence"

// ─── 工具执行 Host ───
export interface IToolExecutionHost {
  readonly taskId: TaskID
  readonly cwd: string
  readonly apiConfiguration: ProviderSettings
  
  pushToolResult(toolResult: Anthropic.ToolResultBlockParam): boolean
  presentAssistantMessage(): Promise<void>
  
  say(
    type: ClineSay,
    text?: string,
    images?: string[],
    partial?: boolean,
    checkpoint?: Record<string, unknown>,
    progressStatus?: ToolProgressStatus,
    options?: { isNonInteractive?: boolean },
    contextCondense?: ContextCondense,
    contextTruncation?: ContextTruncation,
  ): Promise<undefined>
  
  ask(
    type: ClineAsk,
    text?: string,
    partial?: boolean,
    progressStatus?: ToolProgressStatus,
    isProtected?: boolean,
  ): Promise<{ response: string; text?: string; images?: string[] }>
}

// ─── 流处理器 Host ───
export interface IStreamProcessorHost {
  readonly taskId: TaskID
  readonly instanceId: string
  readonly apiConfiguration: ProviderSettings
  
  getTokenUsage(): TokenUsage
  cancelCurrentRequest(): void
  isAborted(): boolean
}

// ─── 生命周期 Host ───
export interface ILifecycleHost {
  readonly taskId: TaskID
  readonly cwd: string
  readonly apiConfiguration: ProviderSettings
  
  addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<void>
  saveClineMessages(): Promise<boolean>
  refreshWebviewState(): Promise<void>
  presentAssistantMessage(): Promise<void>
}

// ─── 消息管理 Host ───
export interface IMessageManagerHost {
  readonly taskId: TaskID
  readonly clineMessages: ClineMessage[]
  readonly apiConversationHistory: ApiMessage[]
  
  saveClineMessages(): Promise<boolean>
  updateClineMessage(message: ClineMessage): Promise<void>
  findMessageById(id: string): ClineMessage | undefined
}
```

### 3.2 Task.ts 构造函数重构

```ts
// 修改: src/core/task/Task.ts 构造函数 (~500行 → ~100行)
export class Task {
  // Handlers — 构造函数中初始化，不再 lazy
  readonly toolHandler: TaskToolHandler
  readonly executor: TaskExecutor
  readonly lifecycleHandler: TaskLifecycleHandler
  readonly msgMgr: TaskMessageManager
  readonly askSayHandler: TaskAskSayHandler
  readonly subtaskHandler: TaskSubtaskHandler
  readonly requestBuilder: TaskRequestBuilder
  readonly streamProcessor: TaskStreamProcessor
  readonly errorRecovery: ErrorRecoveryHandler
  readonly contextManager: TaskContextManager          // 新增
  readonly checkpointManager: TaskCheckpointManager    // 新增
  readonly tokenTracker: TaskTokenTracker              // 新增

  constructor(options: TaskOptions) {
    // 1. 基础状态初始化
    this.taskId = TaskID.make(options.taskId)
    this.instanceId = crypto.randomUUID().slice(0, 8)
    this.cwd = options.workspacePath ?? getWorkspacePath(...)
    // ... 其他直接赋值 ...

    // 2. 创建 Host 接口
    const toolHost: IToolExecutionHost = this.asToolHost()
    const execHost = this.asExecutorHost()   // 返回 TaskExecutorHost
    const lifecycleHost: ILifecycleHost = this.asLifecycleHost()
    const msgHost: IMessageManagerHost = this.asMessageManagerHost()

    // 3. 注入 Handler
    this.toolHandler = new TaskToolHandler(toolHost)
    this.executor = new TaskExecutor(execHost)
    this.lifecycleHandler = new TaskLifecycleHandler(lifecycleHost)
    this.msgMgr = new TaskMessageManager(msgHost)
    this.askSayHandler = new TaskAskSayHandler(this.asAskSayHost())
    this.subtaskHandler = new TaskSubtaskHandler(this.asSubtaskHost())
    this.requestBuilder = new TaskRequestBuilder(this)
    this.streamProcessor = new TaskStreamProcessor(this.asStreamHost())
    this.errorRecovery = new ErrorRecoveryHandler(this.asErrorRecoveryHost())
    this.contextManager = new TaskContextManager(this.asContextHost())
    this.checkpointManager = new TaskCheckpointManager(this.asCheckpointHost())
    this.tokenTracker = new TaskTokenTracker(this.asTokenHost())
  }

  // Host 工厂方法 —— 每个都返回精确接口，零 UnsafeAny
  private asToolHost(): IToolExecutionHost {
    return {
      taskId: this.taskId,
      cwd: this.cwd,
      apiConfiguration: this.apiConfiguration,
      pushToolResult: (r) => this.pushToolResultToUserContent(r),
      presentAssistantMessage: () => this.presentAssistantMessage(),
      say: (...args) => this.say(...args),
      ask: (...args) => this.ask(...args),
    }
  }
  // ... 其他 as*Host() 方法类似
}
```

---

## Phase 4 附录：上下文压缩重构

### 4.1 新增文件

```ts
// 新建: src/core/context-management/trimLargeContent.ts

/**
 * 统一的工具输出裁剪逻辑，合并原 microcompact/snipCompact/reactiveCompact 三者。
 */
export function trimLargeContent(
  messages: ApiMessage[],
  budget: ContentTrimBudget,
): ApiMessage[] {
  let tokens = estimateTotalTokens(messages)
  
  // 1. 裁剪过大的工具结果（原 microcompact 逻辑）
  messages = messages.map((msg) => {
    if (!isToolResult(msg)) return msg
    return trimLargeToolResults(msg, budget.maxToolResultChars)
  })
  
  // 2. 如果仍超预算，裁剪旧的非关键消息（原 snipCompact 逻辑）
  tokens = estimateTotalTokens(messages)
  if (tokens > budget.maxTokens) {
    messages = snipOldMessages(messages, budget)
  }
  
  // 3. 确保最后 N 个 turn 得以保留（原 reactiveCompact 逻辑）
  return preserveRecentTurns(messages, budget.minPreserveTurns)
}

interface ContentTrimBudget {
  maxTokens: number
  maxToolResultChars: number
  minPreserveTurns: number
}
```

### 4.2 管道式 manageContext

```ts
// 修改: src/core/context-management/index.ts

export async function manageContext(
  opts: ContextManagementOptions,
): Promise<ContextManagementResult> {
  // Step 1: 预处理
  let messages = preprocessMessages(opts.messages, {
    contextPercent: (100 * opts.totalTokens) / opts.contextWindow,
    enableMicroCompact: opts.enableMicroCompact ?? true,
  })
  
  // Step 2: 决策
  const decision = makeCompactDecision(opts)
  
  if (decision.action === "skip") {
    return { messages, prevContextTokens: opts.totalTokens, summary: "", cost: 0 }
  }
  
  // Step 3a: 裁剪路径
  if (decision.method === "trim") {
    const trimmed = trimLargeContent(messages, decision.budget)
    return { messages: trimmed, prevContextTokens: opts.totalTokens, summary: "", cost: 0 }
  }
  
  // Step 3b: LLM 压缩路径
  const result = await compactWithLLM(messages, decision, opts)
  
  // Step 4: 恢复上下文
  return postCompactRestore(result.messages, {
    recentFiles: opts.filesReadByRoo?.slice(-5),
  })
}

interface CompactDecision {
  action: "skip" | "trim" | "compress"
  method: "trim" | "llm_summary" | "session_memory"
  reason: string
  budget: ContentTrimBudget
}
```

### 4.3 可删除的文件

- [x] `src/core/context-management/microcompact.ts` → 合并到 trimLargeContent
- [x] `src/core/context-management/snipCompact.ts` → 合并到 trimLargeContent
- [x] `src/core/context-management/reactiveCompact.ts` → 合并到 trimLargeContent
- [ ] `src/core/condense/cacheAwareCompact.ts` → 重构为决策辅助函数

---

## Phase 5 附录：服务层接口

### 5.1 完整服务接口

```ts
// 新建: src/core/services/ITaskSessionService.ts
import type { Task } from "../task/Task"
import type { TaskID } from "../../shared/branded-types"
import type { CreateTaskOptions, HistoryItem } from "@njust-ai-cj/types"

export interface ITaskSessionService {
  /** 创建新任务并开始执行 */
  createTask(options: CreateTaskOptions): Promise<Task>
  /** 从历史恢复任务 */
  resumeTask(historyItem: HistoryItem): Promise<Task>
  /** 获取当前活动任务 */
  getActiveTask(): Task | undefined
  /** 取消指定任务 */
  cancelTask(taskId: TaskID): Promise<void>
  /** 列出所有任务 */
  listTasks(): Task[]
  /** 移除已完成的任务 */
  removeTask(taskId: TaskID): void
  /** 任务被移除时触发 */
  onTaskRemoved(callback: (taskId: TaskID) => void): { dispose(): void }
}
```

```ts
// 新建: src/core/services/IConfigService.ts
export interface IConfigService {
  /** 获取当前模式 */
  getMode(): string
  /** 切换模式 */
  setMode(mode: string): Promise<void>
  /** 获取 Provider 设置 */
  getProviderSettings(): ProviderSettings
  /** 获取完整的扩展状态 */
  getState(): Promise<ExtensionState>
  /** 模式变更时触发 */
  onModeChanged(callback: (mode: string) => void): { dispose(): void }
  /** 设置变更时触发 */
  onConfigChanged(callback: (state: ExtensionState) => void): { dispose(): void }
}
```

### 5.2 ClineProvider 重构目标

```ts
// 修改: src/core/webview/ClineProvider.ts (1474行 → ~300行)
export class ClineProvider implements vscode.WebviewViewProvider {
  constructor(
    context: vscode.ExtensionContext,
    private taskService: ITaskSessionService,
    private configService: IConfigService,
    private mcpService: IMcpService,
    private skillsService: ISkillsService,
    private historyService: IHistoryService,
  ) {
    // 订阅服务事件 → 转发到 WebView
    this.configService.onModeChanged((mode) => {
      void this.postMessageToWebview({ type: "mode", text: mode })
    })
    
    this.taskService.onTaskRemoved((taskId) => {
      void this.postMessageToWebview({ type: "taskRemoved", text: taskId })
    })
  }

  // WebView 消息路由 —— 只做分发，不做业务逻辑
  async handleWebviewMessage(message: ExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case "newTask":
          await this.taskService.createTask(message)
          break
        case "cancelTask":
          await this.taskService.cancelTask(TaskID.from(message.taskId))
          break
        case "switchMode":
          await this.configService.setMode(message.mode)
          break
        case "toggleMcpServer":
          await this.mcpService.toggleServer(message.serverName)
          break
        case "loadSkills":
          await this.skillsService.refresh()
          break
        case "loadHistory":
          await this.historyService.refresh()
          break
        default: {
          const task = this.taskService.getActiveTask()
          if (task) {
            await task.handleWebviewMessage(message)
          }
        }
      }
    } catch (e) {
      await this.postMessageToWebview({
        type: "error",
        text: getErrorMessage(e),
      })
    }
  }
}
```

---

## Phase 6 附录：工具系统

### 6.1 删除弃用工具的命令

```bash
# 删除文件
rm src/core/tools/ApplyDiffTool.ts
rm src/core/tools/SearchReplaceTool.ts

# 验证没有其他文件引用这两个工具
grep -rn "ApplyDiffTool\|SearchReplaceTool" src/ --include="*.ts" | grep -v "node_modules"
# 应该只在 registerAllTools.ts 中有引用 → 删除那两行即可
```

### 6.2 BaseTool 拆分

```ts
// 修改: src/core/tools/BaseTool.ts

// ── 核心接口（~50 行） ──
export abstract class BaseTool<T extends ToolName> {
  abstract readonly name: T
  abstract get inputSchema(): ZodSchema
  abstract execute(
    params: Record<string, unknown>,
    task: IToolExecutionHost,
    callbacks: ToolCallbacks,
  ): Promise<void>
  
  // 生命周期钩子（可选覆写）
  isConcurrencySafe(): boolean { return false }
  requiresCheckpoint(): boolean { return false }
  interruptBehavior(): "pause" | "skip" | "block" { return "block" }
  userFacingName(): string { return this.name }
}

// ── 装饰器函数（各 ~60-100 行，从旧 BaseTool 提取）──

export function withApproval<T extends ToolName>(
  tool: BaseTool<T>,
  permissionEngine: PermissionRuleEngine,
): BaseTool<T> {
  return new (class extends BaseTool<T> {
    readonly name = tool.name
    get inputSchema() { return tool.inputSchema }
    
    async execute(params: Record<string, unknown>, task: IToolExecutionHost, cb: ToolCallbacks) {
      const approval = await permissionEngine.check(tool.name, params)
      if (!approval.allowed) {
        await cb.handleError(new TaskAutoApprovalError(approval.reason))
        return
      }
      await tool.execute(params, task, cb)
    }
  })()
}

export function withProgress<T extends ToolName>(tool: BaseTool<T>): BaseTool<T> {
  return new (class extends BaseTool<T> {
    readonly name = tool.name
    get inputSchema() { return tool.inputSchema }
    
    async execute(params: Record<string, unknown>, task: IToolExecutionHost, cb: ToolCallbacks) {
      await cb.reportProgress?.({ type: "start", tool: tool.name, input: params })
      try {
        await tool.execute(params, task, cb)
        await cb.reportProgress?.({ type: "complete", tool: tool.name })
      } catch (e) {
        await cb.reportProgress?.({ type: "error", tool: tool.name, error: getErrorMessage(e) })
        throw e
      }
    }
  })()
}
```

### 6.3 工具注册管线使用示例

```ts
// 修改: src/core/tools/registerAllTools.ts
import { toolRegistry } from "./ToolRegistry"
import { createToolRegistrationPipeline, registerStaticTools } from "./ToolRegistrationPipeline"
import { PermissionRuleEngine } from "./permissions/PermissionRuleEngine"

// 创建管线
const pipeline = createToolRegistrationPipeline(
  // 注册管理——自动包裹审批/安全/进度
  registerStaticTools(
    rawTools.map((tool) =>
      withSecurityMetrics(
        withProgress(
          withApproval(tool, PermissionRuleEngine.instance),
        ),
      ),
    ),
  ),
)

// 执行
await pipeline({ registry: toolRegistry })
```

---

## Phase 7 附录：SQLite 持久化

### 7.1 完整 Schema

```sql
-- 新建: src/core/persistence/schema.sql

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  root_task_id TEXT,
  parent_task_id TEXT,
  mode TEXT NOT NULL DEFAULT 'build',
  api_config_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT,
  task_description TEXT,
  workspace_path TEXT NOT NULL,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read_tokens INTEGER DEFAULT 0,
  total_cache_write_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  token_count INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_task_time
  ON messages(task_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, updated_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

### 7.2 Repository 实现

```ts
// 新建: src/core/persistence/TaskRepository.ts
import Database from "better-sqlite3"
import type { TaskID } from "../../shared/branded-types"
import type { TaskSummary, TaskStatus } from "./types"

export class TaskRepository {
  constructor(private db: Database.Database) {}

  save(task: TaskSummary): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, mode, status, title, workspace_path,
        total_input_tokens, total_output_tokens, total_cost,
        created_at, updated_at)
      VALUES (@id, @mode, @status, @title, @workspacePath,
        @inputTokens, @outputTokens, @cost,
        @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        mode = @mode,
        status = @status,
        total_input_tokens = @inputTokens,
        total_output_tokens = @outputTokens,
        total_cost = @cost,
        updated_at = @updatedAt
    `)
    stmt.run({
      id: task.id,
      mode: task.mode,
      status: task.status,
      title: task.title ?? null,
      workspacePath: task.workspacePath,
      inputTokens: task.totalTokens.input,
      outputTokens: task.totalTokens.output,
      cost: task.totalCost,
      createdAt: task.time.created,
      updatedAt: task.time.updated,
    })
  }

  findById(id: TaskID): TaskSummary | undefined {
    const row = this.db.prepare(
      "SELECT * FROM tasks WHERE id = ?"
    ).get(id) as TaskRow | undefined
    if (!row) return undefined
    return this.rowToSummary(row)
  }

  list(filter: { mode?: string; limit?: number; offset?: number }): TaskSummary[] {
    let query = "SELECT * FROM tasks WHERE 1=1"
    const params: unknown[] = []
    
    if (filter.mode) {
      query += " AND mode = ?"
      params.push(filter.mode)
    }
    
    query += " ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    params.push(filter.limit ?? 50, filter.offset ?? 0)
    
    const rows = this.db.prepare(query).all(...params) as TaskRow[]
    return rows.map((r) => this.rowToSummary(r))
  }

  delete(id: TaskID): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  }

  private rowToSummary(row: TaskRow): TaskSummary {
    return {
      id: TaskID.from(row.id),
      mode: row.mode,
      status: row.status as TaskStatus,
      title: row.title ?? undefined,
      workspacePath: row.workspace_path,
      totalTokens: {
        input: row.total_input_tokens,
        output: row.total_output_tokens,
      },
      totalCost: row.total_cost,
      time: {
        created: row.created_at,
        updated: row.updated_at,
      },
    }
  }
}
```

---

## Phase 8 附录：错误层级

### 8.1 完整错误类

```ts
// 修改: src/core/task/TaskErrors.ts

/**
 * 基础任务错误类。
 * 所有任务级错误应继承此类，调用方可精确匹配。
 */
export abstract class TaskError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

/** 任务忙 — 正在处理另一个请求 */
export class TaskBusyError extends TaskError {
  constructor(public readonly taskId: string) {
    super(
      `Task ${taskId} is currently processing another request`,
      "TASK_BUSY",
      { taskId },
    )
  }
}

/** 用户中止 */
export class TaskAbortedError extends TaskError {
  constructor(taskId: string, instanceId: string) {
    super(
      `Task ${taskId} was aborted`,
      "TASK_ABORTED",
      { taskId, instanceId },
    )
  }
}

/** 自动审批限制 */
export class TaskAutoApprovalError extends TaskError {
  constructor(reason: string) {
    super(reason, "AUTO_APPROVAL_LIMIT", { reason })
  }
}

/** 工具执行失败 */
export class ToolExecutionError extends TaskError {
  constructor(
    public readonly toolName: string,
    public readonly toolInput: Record<string, unknown>,
    cause: Error,
  ) {
    super(
      `Tool ${toolName} execution failed: ${cause.message}`,
      "TOOL_EXECUTION_FAILED",
      { toolName, toolInput },
    )
    this.stack = cause.stack
  }
}

/** 参数验证失败 */
export class ToolValidationError extends TaskError {
  constructor(
    public readonly toolName: string,
    public readonly validationErrors: string[],
  ) {
    super(
      `Invalid arguments for ${toolName}: ${validationErrors.join(", ")}`,
      "TOOL_VALIDATION_FAILED",
      { toolName, validationErrors },
    )
  }
}

/** 上下文溢出 */
export class ContextOverflowError extends TaskError {
  constructor(
    public readonly currentTokens: number,
    public readonly maxTokens: number,
  ) {
    super(
      `Context overflow: ${currentTokens}/${maxTokens} tokens used`,
      "CONTEXT_OVERFLOW",
      { currentTokens, maxTokens },
    )
  }
}

/** API 速率限制 */
export class RateLimitError extends TaskError {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Rate limited by ${provider}, retry after ${retryAfterMs}ms`,
      "RATE_LIMITED",
      { provider, retryAfterMs },
    )
  }
}

/** 持久化失败 */
export class PersistenceError extends TaskError {
  constructor(operation: string, cause: Error) {
    super(
      `Failed to ${operation}: ${cause.message}`,
      "PERSISTENCE_FAILED",
      { operation },
    )
    this.stack = cause.stack
  }
}
```

### 8.2 调用方精确匹配

```ts
// 典型用法 — 在 TaskExecutor.ts 中
try {
  await this.attemptApiRequest(retryAttempt)
} catch (e) {
  if (e instanceof TaskAbortedError) {
    return true // 用户中止，不再重试
  }
  
  if (e instanceof RateLimitError) {
    await this.host.streamProcessor.backoffAndAnnounce(retryAttempt, e)
    return this.attemptApiRequest(retryAttempt + 1)
  }
  
  if (e instanceof ContextOverflowError) {
    await this.host.errorRecovery.handleContextOverflow(e)
    return this.attemptApiRequest(retryAttempt)
  }
  
  if (e instanceof ToolExecutionError) {
    TelemetryService.reportError(e, TelemetryEventName.TOOL_EXECUTION_ERROR)
    await this.host.say("error", e.message)
    return false
  }
  
  // 未知错误 — 兜底
  TelemetryService.reportError(e, TelemetryEventName.TASK_LIFECYCLE_ERROR)
  throw e
}
```

---

## 迁移检查清单汇总

完成所有 Phase 后，逐一验证：

- [ ] `grep -rn "UnsafeAny" src/core/task/ --include="*.ts"` 输出为空
- [ ] `grep -rn "extends EventEmitter" src/core/task/Task.ts` 已删除
- [ ] `grep -rn "this as UnsafeAny" src/core/ --include="*.ts"` 输出为空
- [ ] ClineProvider.ts 从 1474 行缩减到 400 行以内
- [ ] Task.ts 从 4000+ 行缩减到 1200 行以内（仅状态 + Host 工厂）
- [ ] `manageContext()` 函数不超过 80 行
- [ ] BaseTool.ts 不超过 200 行
- [ ] 所有新增服务接口有对应的单元测试
- [ ] SQLite 数据库创建成功（检查 `globalStorage/roo-code.db`）
- [ ] 旧 VS Code state 数据自动迁移到 SQLite

---

> **版本**: v1.0 | **最后更新**: 2026-06-17 | **关联文档**: [`architecture-optimization-plan.md`](./architecture-optimization-plan.md)
