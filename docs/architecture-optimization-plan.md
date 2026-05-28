# 架构优化计划（借鉴 OpenCode 最佳实践）

> 基于对 **Roo-Code** 与 **OpenCode** 两个项目 `src/` 下 200+ 文件的逐行分析，精确定位优化点并提出具体实施方案。

---

## 目录

- [总体策略](#总体策略)
- [Phase 1：类型安全地基](#phase-1类型安全地基)
- [Phase 2：统一事件系统](#phase-2统一事件系统)
- [Phase 3：完成 Task 分解](#phase-3完成-task-分解)
- [Phase 4：简化上下文压缩](#phase-4简化上下文压缩)
- [Phase 5：服务层提取](#phase-5服务层提取)
- [Phase 6：工具系统标准化](#phase-6工具系统标准化)
- [Phase 7：结构化持久化](#phase-7结构化持久化)
- [Phase 8：错误处理类型化](#phase-8错误处理类型化)
- [实施优先级总览](#实施优先级总览)

---

## 总体策略

本计划通过 **8 个 Phase** 系统性提升 Roo-Code 的代码质量、可维护性和可测试性。核心原则：

1. **不改行为，只改结构** — 每个 Phase 的变更对外部功能零影响
2. **逐层推进** — 从类型安全地基开始，逐步重构上层架构
3. **持续可交付** — 每个 Phase 独立完成，可随时合入主分支

```
Phase 1 (类型安全) ──→ Phase 2 (事件系统) ──→ Phase 3 (Task 分解)
                                                      ↓
Phase 6 (工具标准化) ←── Phase 5 (服务层) ←── Phase 4 (压缩简化)
                                                      ↓
                          Phase 7 (持久化) ──→ Phase 8 (错误类型化)
```

### OpenCode 参考基准

| 维度 | OpenCode 做法 | 优势 |
|------|-------------|------|
| 类型安全 | 零 `any` + Effect Schema 运行时验证 | 编译时 + 运行时双重保障 |
| 事件系统 | `BusEvent.define("type", Schema)` | 全链路类型推导 |
| 服务组织 | `Context.Service<T>()` + `Layer` DI | 松耦合、可独立测试 |
| 上下文压缩 | `select()` → `process()` → `prune()` 三阶段 | 清晰管道，300 行 |
| 工具定义 | `Def<Parameters, Metadata>` + Effect 执行 | 参数自动验证，结果类型化 |
| 错误处理 | `Schema.TaggedErrorClass<T>()` | 调用方可精确匹配和恢复 |

---

## Phase 1：类型安全地基

**工期**：2-3 周 ｜ **风险**：低 ｜ **依赖**：无

### 1.1 问题现状

| 问题 | 具体位置 | 严重程度 |
|------|----------|----------|
| 6 个 Handler 用 `this as UnsafeAny as XxxContext` 回引 Task | `src/core/task/Task.ts:2265` 附近 | 🔴 致命 |
| `ITaskExecutorHost` 接口含 12 处 `UnsafeAny` | `src/core/task/interfaces/ITaskExecutorHost.ts` | 🔴 致命 |
| API 流处理 11 处 `as UnsafeAny` | `src/core/task/TaskExecutor.ts` | 🔴 严重 |
| 上下文压缩参数 `rooIgnoreController as UnsafeAny` | `src/core/context-management/index.ts` | 🟡 中等 |
| 全项目 `string` 型 ID（无品牌区分） | `@njust-ai-cj/types` 中的类型定义 | 🟡 中等 |

### 1.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/session/schema.ts
// 所有 ID 使用品牌类型，不可能误传
export const SessionID = Schema.brand(Schema.String, "SessionID")
export const MessageID = Schema.brand(Schema.String, "MessageID")
export const PartID = Schema.brand(Schema.String, "PartID")

// opencode/packages/opencode/src/tool/tool.ts:20-32
// 无效参数产生类型化错误，LLM 可据此修正输入
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError", { tool: Schema.String, detail: Schema.String }
) {
  override get message() { return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.` }
}
```

### 1.3 实施步骤

#### Step 1.3.1：定义品牌类型层

**新建** `src/shared/branded-types.ts`：

```ts
// 零运行时成本，纯类型安全
declare const TaskIDBrand: unique symbol
declare const MessageIDBrand: unique symbol
declare const ToolCallIDBrand: unique symbol

export type TaskID = string & { readonly [TaskIDBrand]: never }
export type MessageID = string & { readonly [MessageIDBrand]: never }
export type ToolCallID = string & { readonly [ToolCallIDBrand]: never }

export const TaskID = {
  create: (value?: string) => (value ?? uuidv7()) as TaskID,
  parse: (value: string): TaskID => value as TaskID,
}
// MessageID、ToolCallID 同理
```

**影响文件**：`src/shared/branded-types.ts`（新建）

**验收标准**：`Task.id` 类型变为 `TaskID`，`Task.parentTaskId` 类型变为 `TaskID | undefined`

#### Step 1.3.2：消除 ITaskExecutorHost 中的 UnsafeAny

**修改** `src/core/task/interfaces/ITaskExecutorHost.ts`：

```ts
// BEFORE（12 处 UnsafeAny）
export interface TaskExecutorDelegatesHost {
  requestBuilder: {
    inheritCacheFromParent(parent: UnsafeAny): void         // ❌
  }
  streamProcessor: {
    backoffAndAnnounce(retryAttempt: number, error: UnsafeAny): Promise<void>  // ❌
    buildCleanConversationHistory(messages: ApiMessage[]): UnsafeAny[]           // ❌
  }
}

// AFTER（零 UnsafeAny）
export interface TaskExecutorDelegatesHost {
  requestBuilder: {
    inheritCacheFromParent(parent: Task): void              // ✅ 具体类型
  }
  streamProcessor: {
    backoffAndAnnounce(retryAttempt: number, error: Error): Promise<void>        // ✅
    buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.Messages.MessageParam[]  // ✅
  }
}
```

**影响文件**：`src/core/task/interfaces/ITaskExecutorHost.ts`

**验收标准**：`ITaskExecutorHost.ts` 文件中搜索 `UnsafeAny` 返回零结果

#### Step 1.3.3：用 Zod Schema 替代 API 响应层的断言

**修改** `src/core/task/TaskExecutor.ts`（11 处变动）：

```ts
// BEFORE
catch (error: UnsafeAny) {
  yield* handleAttemptApiRequestError({ host: h, error, ... })
}

// AFTER：定义 API 错误类型
const ApiErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
  error: z.string().optional(),
})

catch (error: unknown) {
  const apiError = ApiErrorSchema.safeParse(error)
  if (apiError.success) {
    yield* handleAttemptApiRequestError({ host: h, error: apiError.data, ... })
  }
}
```

**影响文件**：`src/core/task/TaskExecutor.ts`、`src/core/task/TaskStreamConsumer.ts`

**验收标准**：API 流处理的 `catch` 块中无 `as UnsafeAny`

#### Step 1.3.4：TaskMessageManager 去 UnsafeAny

**修改** `src/core/task/Task.ts`（约 2265 行附近）：

```ts
// BEFORE
private get msgMgr(): TaskMessageManager {
  if (!this._taskMessageManager) {
    this._taskMessageManager = new TaskMessageManager(
      this as UnsafeAny as TaskMessageContext  // ❌
    )
  }
  return this._taskMessageManager
}

// AFTER：定义精确的适配器方法
private asMessageContext(): TaskMessageContext {
  return {
    taskId: this.taskId,
    clineMessages: this.clineMessages,
    apiConversationHistory: this.apiConversationHistory,
    saveClineMessages: () => this.saveClineMessages(),
    updateClineMessage: (m) => this.updateClineMessage(m),
    addToApiConversationHistory: (m, r) => this.addToApiConversationHistory(m, r),
  }
}

private get msgMgr(): TaskMessageManager {
  if (!this._taskMessageManager) {
    this._taskMessageManager = new TaskMessageManager(this.asMessageContext())  // ✅
  }
  return this._taskMessageManager
}
```

**影响文件**：`src/core/task/Task.ts`、`src/core/task/TaskAskSayHandler.ts`（同理）

**验收标准**：Task.ts 中搜索 `as UnsafeAny` 返回零结果

---

## Phase 2：统一事件系统

**工期**：1-2 周 ｜ **风险**：低 ｜ **依赖**：无

### 2.1 问题现状

三种事件机制并存，无法追踪事件流：

| 机制 | 位置 | 问题 |
|------|------|------|
| `Task extends EventEmitter` | `src/core/task/Task.ts` | Node.js API，无类型 |
| `TaskEventBus` | `src/core/events/TaskEventBus.ts` | `data?: unknown` |
| `postMessage` | `src/core/webview/ClineProvider.ts` | JSON 序列化，switch 分发 |

### 2.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/bus/bus-event.ts
export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({ server: Schema.String })
)
// 编译时全链路类型安全
bus.publish(ToolsChanged, { server: "xxx" })
bus.subscribe(ToolsChanged, (event) => {
  event.properties.server // ✅ 自动推导为 string
})
```

### 2.3 实施步骤

#### Step 2.3.1：升级 TaskEventBus 为类型安全版本

**修改** `src/core/events/TaskEventBus.ts`：

```ts
// 定义事件 → 负载映射（替代 data?: unknown）
export interface TaskEventMap {
  "task:started":        { taskId: TaskID; mode: string; apiConfigName?: string }
  "task:completed":      { taskId: TaskID; result: string }
  "task:failed":         { taskId: TaskID; error: Error }
  "task:aborted":        { taskId: TaskID; reason: string }
  "task:tool-executing": { taskId: TaskID; tool: ToolName; input: Record<string, unknown>; toolCallId: ToolCallID }
  "task:tool-completed": { taskId: TaskID; tool: ToolName; output: string; metadata: Record<string, unknown> }
  "task:llm-response":   { taskId: TaskID; modelId: string; content: AssistantMessageContent[] }
  "task:tokens-updated": { taskId: TaskID; usage: TokenUsage }
  "task:llm-retry":      { taskId: TaskID; error: Error; attempt: number }
  "task:assistant-message-requested": { taskId: TaskID; data: { task: Task } }
}

export class TypedTaskEventBus {
  emit<K extends keyof TaskEventMap>(event: K, payload: TaskEventMap[K]): void
  on<K extends keyof TaskEventMap>(event: K, listener: (payload: TaskEventMap[K]) => void): DisposableLike
  off<K extends keyof TaskEventMap>(event: K, listener: (payload: TaskEventMap[K]) => void): void
}
```

**影响文件**：`src/core/events/TaskEventBus.ts`

**验收标准**：所有 `.emit()` 调用的第二个参数有编译时类型检查

#### Step 2.3.2：废除 Task 继承 EventEmitter

**修改** `src/core/task/Task.ts`：

```ts
// BEFORE
export class Task extends EventEmitter<TaskEvents> {
  notifyTokenUsage(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
    this.emit(NJUST_AI_CJEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
  }
}

// AFTER
export class Task {
  private bus = taskEventBus

  notifyTokenUsage(tokenUsage: TokenUsage, toolUsage: ToolUsage): void {
    this.bus.emit("task:tokens-updated", { taskId: this.taskId, usage: tokenUsage })
  }
}
```

**影响文件**：`src/core/task/Task.ts`

**验收标准**：Task 不再 extends EventEmitter

#### Step 2.3.3：添加 WebView 桥接适配器

**新建** `src/core/events/WebviewEventBridge.ts`：

```ts
export function bridgeTaskEventsToWebview(
  bus: TypedTaskEventBus,
  postMessage: (msg: ExtensionMessage) => Promise<void>,
): DisposableLike {
  const disposables: DisposableLike[] = []

  disposables.push(bus.on("task:tokens-updated", (payload) => {
    void postMessage({ type: "taskTokenUsage", taskId: payload.taskId, usage: payload.usage })
  }))

  disposables.push(bus.on("task:tool-executing", (payload) => {
    void postMessage({ type: "toolProgress", tool: payload.tool, taskId: payload.taskId })
  }))

  return { dispose: () => disposables.forEach((d) => d.dispose()) }
}
```

**影响文件**：`src/core/events/WebviewEventBridge.ts`（新建）、`src/core/webview/ClineProvider.ts`（调用）

**验收标准**：WebView 通过事件总线自动接收更新，减少 ClineProvider 中的手动 postMessage 调用

---

## Phase 3：完成 Task 分解

**工期**：3-4 周 ｜ **风险**：中（行为不变，但需要大量测试覆盖） ｜ **依赖**：Phase 1

### 3.1 问题现状

8 个 Handler 已提取，但分解不彻底：

| Handler | 状态 | 问题 |
|---------|------|------|
| `TaskMessageManager` | ✅ 完整 | 用 `this as UnsafeAny as TaskMessageContext` |
| `TaskAskSayHandler` | ✅ 完整 | 同上 |
| `TaskToolHandler` | ⚠️ 仅 50 行 | 只做 `pushToolResult`，其他工具逻辑仍在 Task.ts |
| `TaskExecutor` | ✅ 最大提取 | `TaskExecutorHost` 接口但含 UnsafeAny |
| `TaskLifecycleHandler` | ✅ 完整 | `TaskLifecycleHost` 接口 |
| `TaskSubtaskHandler` | ✅ 完整 | `TaskSubtaskHost` 接口 |
| `TaskRequestBuilder` | ✅ 完整 | 直接引用 Task（非接口） |
| `TaskStreamProcessor` | ✅ 完整 | 直接引用 Task（非接口） |
| **剩余 ~1700 行** | ❌ 未提取 | 状态声明、`startTask`、`resumeTaskFromHistory`、上下文管理等 |

### 3.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/session/llm.ts:95-98
// 每个服务独立，通过 Context + Layer 组合
export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}
export const layer = Layer.effect(Service, Effect.gen(function*() {
  const config = yield* Config.Service       // DI 注入
  const provider = yield* Provider.Service
}))
export * as LLM from "./llm"
```

### 3.3 实施步骤

#### Step 3.3.1：为每个 Handler 定义精确 Host 接口

**新建** `src/core/task/interfaces/IHostContracts.ts`：

```ts
// 取代当前零散的 UnsafeAny 接口
export interface IToolExecutionHost {
  readonly taskId: TaskID
  readonly cwd: string
  readonly apiConfiguration: ProviderSettings
  pushToolResult(toolResult: Anthropic.ToolResultBlockParam): boolean
  say(type: ClineSay, text?: string, images?: string[], ...): Promise<undefined>
  ask(type: ClineAsk, text?: string, ...): Promise<{ response: string; text?: string; images?: string[] }>
  presentAssistantMessage(): Promise<void>
  getTokenUsage(): TokenUsage
}

export interface IStreamProcessorHost {
  readonly taskId: TaskID
  readonly api: ApiHandler
  getTokenUsage(): TokenUsage
  combineMessages(messages: ClineMessage[]): ClineMessage[]
}

export interface ILifecycleHost {
  readonly taskId: TaskID
  readonly cwd: string
  readonly apiConfiguration: ProviderSettings
  startTask(task?: string, images?: string[]): Promise<void>
  resumeTaskFromHistory(): Promise<void>
}
```

**影响文件**：`src/core/task/interfaces/IHostContracts.ts`（新建）

**验收标准**：每个 Host 接口中搜索 `UnsafeAny` 返回零结果

#### Step 3.3.2：提取剩余内联方法

**提取内容**：

| 目标 Handlar | 方法来源 | 新文件 |
|-------------|----------|--------|
| `TaskContextManager` | `manageContext()` 调用逻辑 + token 追踪 | `src/core/task/TaskContextManager.ts` |
| `TaskCheckpointManager` | `checkpointSave()` + `checkpointRestore()` | `src/core/task/TaskCheckpointManager.ts` |
| `TaskTokenTracker` | `getTokenUsage()` + `debouncedEmitTokenUsage` | `src/core/task/TaskTokenTracker.ts` |

**影响文件**：
- `src/core/task/TaskContextManager.ts`（新建）
- `src/core/task/TaskCheckpointManager.ts`（新建）
- `src/core/task/TaskTokenTracker.ts`（新建）
- `src/core/task/Task.ts`（删除已迁移方法）

**验收标准**：Task.ts 行数从 ~2400 降至 ~800

#### Step 3.3.3：统一为构造函数注入

**修改** `src/core/task/Task.ts` 构造函数（~500 行 → ~100 行）：

```ts
export class Task {
  // 公开 Handler（替代 lazy getter）
  readonly toolHandler: TaskToolHandler
  readonly executor: TaskExecutor
  readonly lifecycleHandler: TaskLifecycleHandler
  readonly msgMgr: TaskMessageManager
  readonly contextManager: TaskContextManager
  readonly checkpointManager: TaskCheckpointManager
  readonly tokenTracker: TaskTokenTracker

  constructor(options: TaskOptions) {
    // ... 基础状态初始化（保持在一处）...

    // 构造 Host 适配器（闭包捕获 this，类型受控）
    this.toolHandler = new TaskToolHandler(this.asToolHost())
    this.executor = new TaskExecutor(this.asExecutorHost())
    this.lifecycleHandler = new TaskLifecycleHandler(this.asLifecycleHost())
    this.msgMgr = new TaskMessageManager(this.asMessageContext())
    this.contextManager = new TaskContextManager(this.asContextHost())
    this.checkpointManager = new TaskCheckpointManager(this.asCheckpointHost())
    this.tokenTracker = new TaskTokenTracker(this.asTokenHost())
  }

  // Host 工厂方法 — 每个返回精确接口，零 UnsafeAny
  private asToolHost(): IToolExecutionHost { /* ... */ }
  private asExecutorHost(): ITaskExecutorHost { /* ... */ }
  // ...
}
```

**影响文件**：`src/core/task/Task.ts`

**验收标准**：Task.ts 中不再有 `private get xxxHandler(): XxxHandler` 类型的 lazy getter

---

## Phase 4：简化上下文压缩

**工期**：2-3 周 ｜ **风险**：中（影响 LLM 调用行为） ｜ **依赖**：无

### 4.1 问题现状

`manageContext()` 一个函数 250+ 行（`src/core/context-management/index.ts`），交织 5 种策略：

| 策略 | 文件 | 问题 |
|------|------|------|
| `preprocessMessages` | `preprocess.ts` | 分散的预处理逻辑 |
| `microcompact` | `microcompact.ts`（~30 行） | 与 snip 功能重叠 |
| `snipCompact` | `snipCompact.ts`（~60 行） | 同上 |
| `reactiveCompact` | `reactiveCompact.ts`（~20 行） | 仅硬失败后调用，死代码风险 |
| `cacheAwareCompact` | `cacheAwareCompact.ts`（~80 行） | 是"门控"不是压缩，命名误导 |
| `LLM 压缩` | `condense/index.ts`（~1029 行） | 核心逻辑，但与其他策略交织 |
| `sessionMemory` | `condense/sessionMemoryCompact.ts` | 轻量压缩，应作为独立选项 |
| `truncateConversation` | `context-management/index.ts` | 截断回退，含 CSA 评分 |

### 4.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/session/compaction.ts:~180
// 三阶段清晰管道，总共 ~300 行
export const create = () => { /* 创建 compaction 消息 */ }
export const process = () => {
  // 1. select() → 决定保留/压缩策略
  // 2. buildPrompt() → LLM 生成摘要
  // 3. prune() → 裁剪旧工具输出
}
```

### 4.3 实施步骤

#### Step 4.3.1：合并微压缩策略

**删除文件**：
- `src/core/context-management/microcompact.ts`
- `src/core/context-management/snipCompact.ts`
- `src/core/context-management/reactiveCompact.ts`

**新建** `src/core/context-management/trimLargeContent.ts`：

```ts
export function trimLargeContent(
  messages: ApiMessage[],
  budget: { maxTokens: number; reserveTokens: number },
  options?: { preserveRecentTurns?: number },
): ApiMessage[] {
  // 合并 micro/snip/reactive 三者的逻辑（约 80 行）
  // 1. 裁剪大工具结果（原 micro）
  // 2. 裁剪旧文本消息（原 snip）
  // 3. 保留最后 N 个 turn（原 reactive）
}
```

**影响文件**：`src/core/context-management/trimLargeContent.ts`（新建）、`src/core/context-management/index.ts`（更新引用）

**验收标准**：单次函数调用完成所有内容裁剪

#### Step 4.3.2：CacheAwareCompact 改为决策输入

**修改** `src/core/condense/cacheAwareCompact.ts`：

```ts
// BEFORE: shouldSkipCompactForCache() → boolean（门控）
// AFTER: getCompactDecision() → CompactDecision（决策对象）

export interface CompactDecision {
  action: "skip" | "defer" | "compress" | "trim"
  reason: string
  threshold: number
  method?: "llm_summary" | "session_memory" | "trim_content"
  budget?: { maxTokens: number; reserveTokens: number }
}

export function analyzeContext(
  messages: ApiMessage[],
  tokens: number,
  contextWindow: number,
  cacheHitRate: number,
  compactFailures: number,
): CompactDecision {
  // 统一决策逻辑（替代 5 种分散的门控）
  if (cacheHitRate > 0.8) return { action: "defer", reason: "high cache hit rate", threshold: 0 }
  if (compactFailures >= 3) return { action: "trim", reason: "circuit breaker", threshold: 0.5 }
  // ...
}
```

**影响文件**：`src/core/condense/cacheAwareCompact.ts`（重写）、`src/core/context-management/index.ts`（调用新接口）

**验收标准**：压缩决策逻辑集中在一个函数中，不再分散到 5 个文件

#### Step 4.3.3：拆分 manageContext 为管道

**修改** `src/core/context-management/index.ts`：

```ts
// BEFORE: 一个 250 行的 manageContext() 函数
// AFTER: 管道式处理

export async function manageContext(
  opts: ContextManagementOptions,
): Promise<ContextManagementResult> {
  // Step 1: 预处理
  const messages = preprocessMessages(opts.messages, {
    contextPercent: (100 * opts.totalTokens) / opts.contextWindow,
    enableMicroCompact: opts.enableMicroCompact,
  })

  // Step 2: 决策
  const decision = analyzeContext(
    messages, opts.totalTokens, opts.contextWindow,
    opts.cacheHitRate ?? 0, opts.compactFailures ?? 0,
  )

  if (decision.action === "skip" || decision.action === "defer") {
    return { messages, prevContextTokens: opts.totalTokens, summary: "", cost: 0 }
  }

  // Step 3a: LLM 压缩 或 3b: 截断
  if (decision.method === "llm_summary" || decision.method === "session_memory") {
    return compactWithLLM(messages, opts, decision)
  }

  // Step 3c: 智能截断
  const hierarchy = buildContextHierarchy(messages, opts.taskId)
  return truncateConversation(messages, decision.budget?.maxTokens ?? 0.5, opts.taskId, hierarchy)
}
```

**影响文件**：`src/core/context-management/index.ts`（重构）、新提取的辅助函数

**验收标准**：`manageContext` 函数 ≤ 60 行，每个步骤有独立函数

---

## Phase 5：服务层提取

**工期**：2-3 周 ｜ **风险**：中 ｜ **依赖**：Phase 3

### 5.1 问题现状

`ClineProvider.ts` **1474 行**，承载所有功能：

- WebView 消息路由
- Task 生命周期管理
- MCP 管理
- 设置同步
- 模式切换
- Provider 状态
- 技能管理
- 历史追踪

无法独立测试任何一个子系统。

### 5.2 OpenCode 参考

```ts
// opencode: 每个子系统是独立服务，通过 DI 组合
SessionPrompt.layer
  .pipe(Layer.provide(LLM.defaultLayer))
  .pipe(Layer.provide(Config.defaultLayer))
  .pipe(Layer.provide(Plugin.defaultLayer))
```

### 5.3 实施步骤

#### Step 5.3.1：定义服务接口

**新建** `src/core/services/` 目录：

```
src/core/services/
├── ITaskSessionService.ts    ← 任务生命周期
├── IConfigService.ts         ← 配置/模式管理
├── IMcpService.ts            ← MCP 管理
├── ISettingsService.ts       ← 设置同步
├── ISkillsService.ts         ← 技能管理
└── IHistoryService.ts        ← 历史追踪
```

```ts
// ITaskSessionService.ts
export interface ITaskSessionService {
  createTask(opts: CreateTaskOptions): Task
  getActiveTask(): Task | undefined
  cancelTask(taskId: TaskID): Promise<void>
  listTasks(): Task[]
  switchToTask(taskId: TaskID): void
}

// IConfigService.ts
export interface IConfigService {
  getMode(): string
  setMode(mode: string): Promise<void>
  getProviderSettings(): ProviderSettings
  onModeChanged(callback: (mode: string) => void): DisposableLike
}
```

**影响文件**：`src/core/services/`（新建目录）

**验收标准**：接口定义完整，编译通过

#### Step 5.3.2：提取实现类

```ts
// src/core/services/TaskSessionService.ts
export class TaskSessionService implements ITaskSessionService {
  private activeTask?: Task
  private tasks = new Map<TaskID, Task>()

  createTask(opts: CreateTaskOptions): Task {
    const task = new Task(opts)
    this.tasks.set(task.taskId, task)
    this.activeTask = task
    return task
  }

  getActiveTask(): Task | undefined {
    return this.activeTask
  }
  // ...
}
```

**影响文件**：
- `src/core/services/TaskSessionService.ts`（新建）
- `src/core/services/ConfigService.ts`（新建）
- 其他实现类

**验收标准**：每个服务独立可测试（传入 mock 依赖即可）

#### Step 5.3.3：精简 ClineProvider

**修改** `src/core/webview/ClineProvider.ts`：

```ts
// AFTER: ClineProvider 只做 WebView ↔ Service 路由
export class ClineProvider {
  constructor(
    private taskService: ITaskSessionService,
    private configService: IConfigService,
    private mcpService: IMcpService,
    private settingsService: ISettingsService,
    private skillsService: ISkillsService,
    private historyService: IHistoryService,
  ) {}

  async handleWebviewMessage(msg: ExtensionMessage): Promise<void> {
    switch (msg.type) {
      case "newTask":       return this.taskService.createTask(msg)
      case "cancelTask":    return this.taskService.cancelTask(msg.taskId)
      case "switchMode":    return this.configService.setMode(msg.mode)
      case "toggleMcpServer": return this.mcpService.toggle(msg.serverName)
      // 纯路由，不含业务逻辑
    }
  }
}
```

**影响文件**：`src/core/webview/ClineProvider.ts`（大幅缩减）

**验收标准**：ClineProvider 从 1474 行降至 ~300 行

---

## Phase 6：工具系统标准化

**工期**：1-2 周 ｜ **风险**：低 ｜ **依赖**：无

### 6.1 问题现状

| 问题 | 位置 | 严重程度 |
|------|------|----------|
| 已弃用工具仍注册 | `ApplyDiffTool`、`SearchReplaceTool` | 🟡 中等 |
| `BaseTool.ts` 732 行 | 审批/进度/缓存/安全/验证/钩子/预算全在一个类 | 🔴 严重 |
| 参数类型分散 | 每个工具文件定义自己的接口 | 🟡 中等 |

### 6.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/tool/tool.ts
// 工具是纯数据结构，薄封装
export interface Def<Parameters, Metadata> {
  id: string
  description: string
  parameters: Schema.Decoder<unknown>     // 统一验证
  jsonSchema?: JSONSchema7
  execute(args, ctx): Effect.Effect<ExecuteResult<M>>
}
```

### 6.3 实施步骤

#### Step 6.3.1：删除弃用工具

**删除文件**：
- `src/core/tools/ApplyDiffTool.ts`（→ `ApplyPatchTool`）
- `src/core/tools/SearchReplaceTool.ts`（→ `EditTool`）

**修改** `src/core/tools/registerAllTools.ts`：移除对应 import 和注册条目

**验收标准**：搜索 `@deprecated` 在 `src/core/tools/` 下返回零结果

#### Step 6.3.2：拆分 BaseTool 为可组合装饰器

**新建 `src/core/tools/decorators/`**：

```
src/core/tools/decorators/
├── withApproval.ts       ← 审批逻辑（~50 行）
├── withProgress.ts       ← 进度报告（~40 行）
├── withCache.ts          ← 结果缓存（~60 行）
├── withSecurity.ts       ← 安全指标（~30 行）
├── withHooks.ts          ← 钩子系统（~50 行）
├── withResultBudget.ts   ← 结果预算/截断（~70 行）
└── index.ts              ← 统一导出
```

**修改** `src/core/tools/BaseTool.ts`：缩减至 ~100 行（只保留名称、Schema、execute）

```ts
// 使用示例
const readFileTool = composeTool(new ReadFileTool(),
  withApproval,
  withCache(),
  withSecurity(),
  withResultBudget({ maxChars: 50000 }),
)
```

**验收标准**：BaseTool.ts 从 732 行降至 ≤ 120 行

#### Step 6.3.3：统一共享参数类型

**新建** `src/core/tools/shared-params.ts`：

```ts
export interface FilePathParam   { filePath: string }
export interface ContentParam     { content: string }
export interface SearchPatternParam { pattern: string; caseSensitive?: boolean; recursive?: boolean }
export interface LineRangeParam   { startLine?: number; endLine?: number }
export interface CommandParam     { command: string; cwd?: string; timeout?: number }
```

**影响文件**：`src/core/tools/shared-params.ts`（新建）、所有使用这些参数的工具文件

**验收标准**：工具文件中不再重复定义 `{ filePath: string }`

---

## Phase 7：结构化持久化

**工期**：4-6 周 ｜ **风险**：高（涉及数据迁移） ｜ **依赖**：无

### 7.1 问题现状

| 问题 | 具体 |
|------|------|
| 使用 VS Code `globalState` / `workspaceState` | 键值存储，无查询能力 |
| 任务历史无法按日期/模式/Token 消耗查询 | 只能遍历 keys |
| 无数据迁移机制 | 版本升级可能丢失数据 |

### 7.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/session/session.sql.ts
const SessionTable = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  title: text().notNull(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
  // ...
})
```

### 7.3 实施步骤

#### Step 7.3.1：引入 better-sqlite3

**新建** `src/core/persistence/database.ts`：

```ts
import Database from "better-sqlite3"
import path from "path"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  root_task_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT,
  workspace_path TEXT NOT NULL,
  total_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_task_time
  ON messages(task_id, timestamp);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

export function openDatabase(globalStoragePath: string): Database.Database {
  const dbPath = path.join(globalStoragePath, "roo-code.db")
  const db = new Database(dbPath)

  // WAL 模式提升并发性能
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA)

  return db
}
```

**影响文件**：`src/core/persistence/database.ts`（新建）

**依赖**：`better-sqlite3`（VS Code 扩展兼容，需加入 `package.json` 依赖）

#### Step 7.3.2：定义 Repository 层

**新建**：

```
src/core/persistence/
├── database.ts              ← Step 7.3.1
├── TaskRepository.ts         ← Task CRUD
├── MessageRepository.ts      ← 消息 CRUD
├── migrations/
│   ├── index.ts              ← 迁移入口
│   ├── 001_initial.ts        ← 初始 Schema
│   └── 002_add_token_cost.ts ← 示例迁移
└── index.ts
```

```ts
// src/core/persistence/TaskRepository.ts
export class TaskRepository {
  constructor(private db: Database.Database) {}

  save(task: TaskSnapshot): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO tasks (id, mode, status, title, workspace_path, total_tokens, total_cost, created_at, updated_at)
      VALUES (@id, @mode, @status, @title, @workspacePath, @totalTokens, @totalCost, @createdAt, @updatedAt)
    `).run({ /* ... */ })
  }

  list(filter: { mode?: string; limit?: number; offset?: number } = {}): TaskSnapshot[] {
    let sql = "SELECT * FROM tasks WHERE 1=1"
    if (filter.mode) sql += " AND mode = @mode"
    sql += " ORDER BY updated_at DESC LIMIT @limit OFFSET @offset"
    return this.db.prepare(sql).all(filter)
  }

  getTaskStats(): { totalTasks: number; totalTokens: number; totalCost: number } {
    return this.db.prepare(`
      SELECT COUNT(*) as totalTasks, SUM(total_tokens) as totalTokens, SUM(total_cost) as totalCost
      FROM tasks
    `).get()
  }
}
```

**验收标准**：可通过 SQL 查询历史任务（按模式、日期范围等）

#### Step 7.3.3：向后兼容 + 自动迁移

```ts
// src/core/persistence/TaskRepository.ts 的 getTask 方法
async getTask(id: TaskID): Promise<TaskSnapshot | undefined> {
  // 先查 SQLite
  const fromDb = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)
  if (fromDb) return fromDb

  // 回退到旧 VS Code State 数据（透明迁移）
  const fromState = this.globalState.get<TaskSnapshot>(`task:${id}`)
  if (fromState) {
    this.save(fromState)  // 自动迁移
  }
  return fromState
}
```

**影响文件**：`src/core/task-persistence/TaskHistoryStore.ts`（更新读取路径）

**验收标准**：旧任务数据自动迁移到 SQLite，用户无感知

---

## Phase 8：错误处理类型化

**工期**：1-2 周 ｜ **风险**：低 ｜ **依赖**：Phase 3

### 8.1 问题现状

所有错误用 `throw new Error("msg")`，调用方只能 `catch (e) { getErrorMessage(e) }`，无法根据错误类型做差异恢复。

### 8.2 OpenCode 参考

```ts
// opencode/packages/opencode/src/permission/index.ts:80-100
export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()(
  "PermissionRejectedError", {}
) {}
export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()(
  "PermissionDeniedError", { ruleset: Schema.Any }
) {}
```

### 8.3 实施步骤

#### Step 8.3.1：定义错误层级

**修改** `src/core/task/TaskErrors.ts`（扩展）：

```ts
export class TaskError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "TaskError"
  }
}

// ── 具体错误类型 ──

export class TaskBusyError extends TaskError {
  constructor(public readonly taskId: TaskID) {
    super(`Task ${taskId} is currently processing`, "TASK_BUSY", { taskId })
  }
}

export class ToolExecutionError extends TaskError {
  constructor(
    public readonly toolName: string,
    public readonly toolInput: Record<string, unknown>,
    cause: Error,
  ) {
    super(`Tool ${toolName} failed: ${cause.message}`, "TOOL_EXECUTION_FAILED", {
      toolName,
      toolInput: JSON.stringify(toolInput),
    })
  }
}

export class ContextOverflowError extends TaskError {
  constructor(
    public readonly currentTokens: number,
    public readonly maxTokens: number,
  ) {
    super(`Context overflow: ${currentTokens}/${maxTokens} tokens`, "CONTEXT_OVERFLOW", {
      currentTokens,
      maxTokens,
    })
  }
}

export class RateLimitError extends TaskError {
  constructor(
    public readonly provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(`Rate limited by ${provider}, retry after ${retryAfterMs}ms`, "RATE_LIMITED", {
      provider,
      retryAfterMs,
    })
    this.name = "RateLimitError"
  }
}

export class TaskAbortedError extends TaskError {
  constructor(taskId: TaskID, instanceId: string) {
    super(`Task ${taskId} aborted by user`, "TASK_ABORTED", { taskId, instanceId })
  }
}

export class TaskAutoApprovalError extends TaskError {
  constructor(message: string) {
    super(message, "AUTO_APPROVAL_LIMIT", {})
  }
}
```

**影响文件**：`src/core/task/TaskErrors.ts`

**验收标准**：所有 Task 相关错误继承自 `TaskError`

#### Step 8.3.2：在调用方精确匹配

**修改** `src/core/task/TaskExecutor.ts`（错误处理部分）：

```ts
try {
  const stream = this.host.attemptApiRequest(retryAttempt)
  // ...
} catch (e) {
  if (e instanceof RateLimitError) {
    await this.host.streamProcessor.backoffAndAnnounce(retryAttempt, e)
    return  // 自动重试
  }
  if (e instanceof ContextOverflowError) {
    await this.host.errorRecovery.handleContextOverflow(e)
    return
  }
  if (e instanceof TaskAbortedError) {
    return true  // 不重试，直接停止
  }
  if (e instanceof ToolExecutionError) {
    // 向 LLM 反馈具体工具错误
    await this.host.say("tool_error", e.message)
    return
  }
  // 未知错误 → 遥测 + 通用恢复
  TelemetryService.reportError(e, TelemetryEventName.TASK_LIFECYCLE_ERROR)
  throw e
}
```

**影响文件**：`src/core/task/TaskExecutor.ts`、`src/core/task/TaskStreamProcessor.ts`、`src/core/task/TaskRetryHandler.ts`

**验收标准**：错误恢复逻辑不再依赖字符串匹配

---

## 实施优先级总览

| Phase | 工期 | 风险 | 依赖 | 可并行 | 建议执行 |
|-------|------|------|------|--------|----------|
| **P1** 类型安全 | 2-3 周 | 🟢 低 | 无 | P2 | 第 1-3 周 |
| **P2** 事件系统 | 1-2 周 | 🟢 低 | 无 | P1 | 第 1-2 周 |
| **P3** Task 分解 | 3-4 周 | 🟡 中 | P1 | — | 第 4-7 周 |
| **P4** 压缩简化 | 2-3 周 | 🟡 中 | 无 | P6 | 第 4-6 周 |
| **P5** 服务层 | 2-3 周 | 🟡 中 | P3 | — | 第 8-10 周 |
| **P6** 工具标准 | 1-2 周 | 🟢 低 | 无 | P4 | 第 4-5 周 |
| **P7** 持久化 | 4-6 周 | 🔴 高 | 无 | — | 按需 |
| **P8** 错误类型 | 1-2 周 | 🟢 低 | P3 | — | 第 8-9 周 |

**推荐执行顺序**：

```
第 1-3 周:  P1 + P2 并行   （打好类型安全和事件总线地基）
第 4-7 周:  P3             （Task 重构为主力，P4/P6 可穿插并行）
第 8-10 周: P5 + P8 并行   （服务层提取 + 错误类型化收尾）
后续:       P7             （持久化升级，独立推进）
```

---

## 风险控制

1. **每个 Phase 在独立分支开发**，合并前通过全量测试
2. **Phase 3（Task 分解）需要最高测试覆盖率**，建议同步补充单元测试
3. **Phase 7（持久化）使用向后兼容 + 自动迁移**，数据丢失风险可控
4. **每个 Phase 可独立交付**，不阻塞功能迭代
