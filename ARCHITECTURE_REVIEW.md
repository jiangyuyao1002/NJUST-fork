# Njust-AI 项目架构综合评估报告

> **审查日期**：2026 年 4 月 15 日  
> **审查范围**：`d:\NJUST_AI\Njust-AI\src\`、`packages\`，涵盖核心模块、服务层、API 层、工具系统、提示词系统  
> **审查方法**：基于 5 份专项审查报告（核心模块膨胀、模块间耦合、工具系统、API 提供商层、提示词系统）的交叉分析与综合评估  

---

## 1. 执行摘要

### 1.1 项目概况

| 项目 | 说明 |
|------|------|
| **项目名称** | Njust-AI（基于 VS Code 的 AI 编程助手） |
| **代码规模** | 1000+ TypeScript 文件（不含测试），核心源码位于 `src/` 和 `packages/` |
| **技术栈** | TypeScript、VS Code Extension API、Node.js、React（Webview）、pnpm monorepo（Turborepo） |
| **架构类型** | 分层单体架构（core → services → api → shared），搭配 monorepo 包管理 |
| **核心能力** | 支持 40+ LLM 提供商、44+ 原生工具、MCP 协议集成、多模式任务执行 |

### 1.2 审查范围与方法论

本报告汇总了以下 5 个专项审查维度的结果：

1. **核心模块膨胀审查**：聚焦 `Task.ts`（5181 行）、`ClineProvider.ts`（3376 行）、`McpHub.ts`（2052 行）三大核心文件的 SRP 违规、方法复杂度、状态管理与可测试性。
2. **模块间耦合与依赖审查**：系统性的导入关系追踪、循环依赖检测、分层架构合规性验证。
3. **工具系统架构审查**：44+ 工具的注册/分发/执行链路、权限系统、并发管理、参数验证一致性。
4. **API 提供商层架构审查**：37 个 Provider 实现的工厂模式质量、接口统一性、流处理、错误处理、Token 计数与扩展性。
5. **提示词系统架构审查**：66 个文件的提示词组织、Section 分层、硬编码问题、业务逻辑耦合与可维护性。

### 1.3 核心结论

Njust-AI 在功能覆盖度上表现出色——支持 40+ LLM 提供商、44+ 工具、MCP 协议、多模式任务执行等，展现了强大的产品能力和快速迭代的工程节奏。然而，伴随快速增长而来的是**显著的架构技术债**：三大核心文件合计超过 10,000 行形成"上帝类"；两条关键循环依赖（`webview↔task`、`mcp↔webview`）制约了模块化演进；API 层缺少重试机制和精确的 Token 计数；提示词系统中大量业务逻辑与模板生成混杂。

**综合架构质量评分为 2.8/5.0**，处于"功能完整但架构需要系统性改进"的阶段。好消息是，项目已开始部分模块化探索（如 `ToolExecutionOrchestrator`、`TaskLifecycle`、`TaskMetrics` 等），为后续重构奠定了基础。

---

## 2. 架构质量评分卡

| 维度 | 评分 | 说明 |
|------|:----:|------|
| **模块化** (Modularity) | **2.5/5** | 三大核心文件严重膨胀（Task 5181 行、ClineProvider 3376 行、McpHub 2052 行），职责边界模糊。工具系统模块化设计良好（5/5），但被核心模块拖低。 |
| **耦合度** (Coupling，分高=低耦合) | **2.0/5** | 存在 2 条循环依赖（webview↔task、mcp↔webview）、6 项分层违规（shared→core、api→core、utils→core），ClineProvider 被 8+ 模块直接导入。 |
| **内聚性** (Cohesion) | **2.5/5** | Task.ts 承担 7+ 项职责（生命周期、LLM 对话、工具链、上下文、持久化、Webview、遥测），ClineProvider 是"前端控制塔"，内聚性严重不足。 |
| **可扩展性** (Extensibility) | **3.0/5** | 工具系统扩展性优秀（开闭原则，2 步添加新工具），但 API 层新增提供商需修改 7+ 处、25+ 分支的 switch 语句违反开闭原则。 |
| **可维护性** (Maintainability) | **2.5/5** | 高复杂度方法（70-100+ 行）、深层嵌套（≥3 层）、魔术数字散布、缺少接口定义和依赖注入，修改风险高。 |
| **可测试性** (Testability) | **3.0/5** | 新增的纯逻辑类（AdaptiveConcurrencyController 等）可测试性好，但核心类构造器依赖过多、无法 mock，提示词系统缺少 Section 隔离测试。 |
| **综合评分** | **2.8/5** | **需要系统性改进** |

---

## 3. 各模块审查摘要

### 3.1 核心模块膨胀

三大核心文件合计超过 **10,609 行**，是项目最突出的架构问题。

- **Task.ts（5181 行）**：承担任务生命周期、LLM 对话、工具链调度、上下文管理、MCP 集成、持久化、Webview 通知等 7+ 项职责，是典型的"上帝类"。已有 `TaskLifecycle`、`TaskMetrics`、`ToolExecutionOrchestrator` 等模块化雏形，但尚未完成抽象收口。本次新增的并发控制器存在 `dispose()` 中三次重复重置的代码缺陷。
- **ClineProvider.ts（3376 行）**：混合 Webview 生命周期、任务管理、配置/模式管理、MCP/Skills 初始化、遥测等职责。`handleModeSwitch` 等方法约 90 行，嵌套层级深。
- **McpHub.ts（2052 行）**：融合配置解析、三种传输协议建立、连接生命周期管理、资源同步、UI 回调等职责，单个连接方法约 190 行。

### 3.2 模块间耦合

**总体耦合度评级：7/10（中-高度耦合）**

- **循环依赖 1**（🔴 严重）：`core/webview` ↔ `core/task`，两个最大文件互相导入。
- **循环依赖 2**（🔴 中高）：`services/mcp` ↔ `core/webview`，McpHub 和 McpServerManager 反向依赖 ClineProvider。
- **分层违规**：`shared/modes.ts` 导入 `core/prompts`（破坏共享层独立性）；9 个 API Provider 文件导入 `core/assistant-message`；`utils` 层导入 `core`。
- **接口抽象评分：2.5/5**——模块间通过直接导入具体实现类通信，几乎无接口定义和依赖注入。
- **packages/core 内容不足**：仅 3 个子目录，大量应属平台无关的核心逻辑仍在 `src/` 中。

### 3.3 工具系统

**统一性评分：3/5 | 扩展性评分：4/5**

- **架构强项**：模块化设计优秀（关注点分离）、开闭原则执行良好（新增工具仅需 2 步）、权限系统采用分层规则引擎 + 可插拔分类器链、自适应并发控制 + 工具依赖图支持传递中止。
- **关键问题**：参数验证存在 3 种不同模式（不一致）；编辑工具重叠（`edit`/`edit_file`/`search_replace`）导致混淆；`bypass` 权限模式无安全警告（**P0 安全风险**）；命令执行缺少危险操作检查（**P0 安全风险**）；超时/重试配置硬编码。

### 3.4 API 提供商层

**整体评分：2.9/5**

- **架构强项**：清晰的 `ApiHandler` 接口定义、统一的 `ApiStream`（AsyncGenerator）流处理、完善的模型回退机制（FallbackApiHandler）、40+ 提供商的广泛覆盖。
- **关键问题**：工厂函数中 25+ 分支的 switch 语句违反开闭原则；**完全缺少指数退避重试和 429 速率限制处理**；Token 计数全部使用 tiktoken（精度偏差可达 ±15%）；新增提供商需修改 7+ 处文件；格式转换代码重复（1000+ 行）；错误分类不够细致。

### 3.5 提示词系统

**整体评分：3.1/5**

- **架构强项**：清晰的单一入口点（`SYSTEM_PROMPT()`）、Section 分层结构（优先级 0-4）、令牌预算管理与缓存破裂检测、强大的用户自定义机制（6 种规则来源）。
- **关键问题**：业务逻辑严重嵌入提示词生成——`cangjie-context.ts`（3134 行）混杂错误分析引擎、`custom-instructions.ts`（629 行）混杂文件 I/O、`multi-file-context.ts`（531 行）混杂 import 解析与编辑器集成。入口函数 13 个参数，魔术数字散布，国际化仅表层支持，无提示词版本管理。

---

## 4. 关键风险清单

### P0 — 紧急（影响安全性、稳定性或核心架构）

| # | 问题描述 | 影响范围 | 涉及文件/模块 | 建议修复方案 |
|---|---------|---------|-------------|------------|
| 1 | **工具权限 bypass 模式无安全警告** | 任何工具均可绕过权限检查，存在安全漏洞 | `src/core/tools/` 权限系统 | 为 bypass 模式添加显式安全警告和审计日志 |
| 2 | **命令执行缺少危险操作检查** | 用户可通过工具执行 `rm -rf` 等破坏性命令 | `execute_command` 工具 | 引入命令黑名单/白名单机制和确认提示 |
| 3 | **API 层完全缺少指数退避重试** | 429/500 错误直接传播，用户体验差，服务中断风险 | `src/api/providers/` 全部 Provider | 实现通用重试框架，支持指数退避和可配置重试策略 |
| 4 | **API 层无 429 速率限制处理** | 高频调用时被限流后无法自动恢复 | `src/api/providers/`、`error-handler.ts` | 在重试框架中特别处理 429 状态码，根据 `Retry-After` 头延迟重试 |
| 5 | **核心循环依赖：webview ↔ task** | 两个 5000+/3300+ 行文件互相导入，任何改动需同时修改两个文件 | `Task.ts`、`ClineProvider.ts` | 引入事件总线或接口抽象，打破直接导入依赖 |
| 6 | **核心循环依赖：mcp ↔ webview** | 服务层反向依赖 UI 层，违反分层架构原则 | `McpHub.ts`、`McpServerManager.ts`、`ClineProvider.ts` | 定义 `IMcpStatusSink` 接口，McpHub 依赖接口而非实现 |
| 7 | **Task.dispose 重复重置并发控制器** | 代码冗余，维护风险（本次提交引入） | `Task.ts` L2373-L2393 | 合并为单一 `try` 块 |

### P1 — 重要（影响可维护性和开发效率）

| # | 问题描述 | 影响范围 | 涉及文件/模块 | 建议修复方案 |
|---|---------|---------|-------------|------------|
| 8 | **Token 计数全用 tiktoken，精度 ±15%** | 成本计算不准确，预算控制失效 | `base-provider.ts`、`countTokens.ts` | 为主要提供商实现 native token counting |
| 9 | **工厂函数 25+ switch 分支** | 新增提供商需修改核心文件 7+ 处，违反开闭原则 | `src/api/index.ts` | 改为提供商注册表模式（ProviderRegistry） |
| 10 | **shared 层依赖 core 层** | 破坏共享层独立性，阻碍模块复用 | `shared/modes.ts` → `core/prompts` | 将被依赖的提示词常量下移到 shared 层 |
| 11 | **9 个 API Provider 依赖 core/assistant-message** | API 层与核心实现紧耦合 | 9 个 provider 文件 | 定义 `IToolCallParser` 接口，Provider 依赖接口 |
| 12 | **提示词系统嵌入大量业务逻辑** | cangjie-context（3134 行）混杂错误分析、import 解析等 | `cangjie-context.ts`、`custom-instructions.ts`、`multi-file-context.ts` | 分离为独立的服务（CangjieErrorAnalyzer、RuleFileManager、ImportContextResolver） |
| 13 | **参数验证不一致（3 种模式）** | 工具行为不可预测，维护困难 | 工具系统各工具实现 | 统一参数验证框架，使用 Schema 校验 |
| 14 | **编辑工具重叠** | `edit`/`edit_file`/`search_replace` 功能混淆 | 对应的 3 个工具文件 | 合并或明确区分使用场景，废弃冗余工具 |
| 15 | **SYSTEM_PROMPT() 13 个参数** | 调用复杂，扩展困难 | `system.ts` | 封装为 `PromptGenerationConfig` 对象 |
| 16 | **格式转换代码重复 1000+ 行** | 维护成本高，bug 修复需多处同步 | `src/api/transform/` 各 format 文件 | 抽取公共转换基类或工具函数 |

### P2 — 改进（提升代码质量和开发体验）

| # | 问题描述 | 影响范围 | 涉及文件/模块 | 建议修复方案 |
|---|---------|---------|-------------|------------|
| 17 | **缺乏依赖注入框架** | 无法 mock、测试困难、环境切换困难 | 全项目 | 引入轻量级 DI 容器或工厂模式 |
| 18 | **packages/core 内容严重不足** | 平台无关核心逻辑仍在 src/，无法跨平台复用 | `packages/core/`（仅 3 子目录） | 逐步迁移 task-execution、prompt-engine、tool-framework |
| 19 | **提示词无版本管理** | 无法追踪/回滚提示词变化，无法 A/B 测试 | `src/core/prompts/` | 添加 Section 版本 ID 和变更日志 |
| 20 | **超时/重试配置硬编码** | 不同提供商/场景需不同配置 | `timeout-config.ts`、各 Provider | 支持按提供商和场景的细粒度超时配置 |
| 21 | **魔术数字散布** | 维护时需全文搜索，易遗漏 | 提示词系统多个文件 | 集中到 `prompts/config.ts` 导出命名常量 |
| 22 | **OpenAI-Native 单文件 1600 行** | 阅读和维护困难 | `openai-native.ts` | 拆分为 base/responses/tools/reasoning 四个文件 |
| 23 | **成本追踪无聚合分析** | 无法生成成本报告、无预算告警 | `globalCostTracker` | 添加会话级汇总、模型对比、异常检测 |

---

## 5. 详细改进建议

### A. 核心类拆分

#### A.1 Task.ts 拆分方案

**问题现状**：`Task.ts` 当前 5181 行，承担 7+ 项职责——任务生命周期管理、LLM 对话循环、工具链调度、上下文窗口管理、MCP 集成、持久化、Webview 通知——是典型的"上帝类"。任何单一职责的修改都有可能波及其他逻辑，合并冲突频发，单元测试几乎无法隔离。

**具体改进方案**：将 Task 拆分为以下 4 个核心模块，Task 本身退化为一个薄协调层（Facade）：

```typescript
// 1. TaskExecutor —— 负责 LLM 对话循环与流式处理
//    从 Task 中提取 recursivelyMakeClineRequests、attemptApiRequest、
//    presentAssistantMessage 等方法
class TaskExecutor {
  constructor(
    private apiHandler: ApiHandler,
    private toolOrchestrator: IToolExecutionOrchestrator,
    private contextManager: ContextWindowManager
  ) {}

  async executeConversationLoop(messages: Message[]): Promise<TaskResult> {
    // 原 Task 中的 LLM 对话循环逻辑
  }

  async handleStreamChunk(chunk: ApiStreamChunk): Promise<void> {
    // 原 Task 中的流式响应处理逻辑
  }
}

// 2. TaskLifecycleManager —— 负责任务状态机、启动/恢复/中止
//    从 Task 中提取 startTask、resumeTaskFromHistory、abortTask、
//    dispose 等方法
class TaskLifecycleManager {
  constructor(
    private executor: TaskExecutor,
    private persistence: TaskPersistence,
    private eventEmitter: ITaskEventEmitter
  ) {}

  async start(config: TaskConfig): Promise<void> { /* ... */ }
  async resume(historyItem: HistoryItem): Promise<void> { /* ... */ }
  async abort(reason: string): Promise<void> { /* ... */ }
  dispose(): void {
    // 合并当前重复的三次 dispose 调用为单一 try 块
  }
}

// 3. ToolExecutionContext —— 工具执行的上下文环境
//    完成已有 ToolExecutionOrchestrator 的抽象收口，
//    将 Task 中直接操纵 controller/scheduler/stats 的代码全部迁入
class ToolExecutionContext {
  constructor(
    private orchestrator: ToolExecutionOrchestrator,
    private concurrencyController: AdaptiveConcurrencyController,
    private scheduler: ToolExecutionScheduler
  ) {}

  async executeTool(toolUse: ToolUse): Promise<ToolResult> { /* ... */ }
  async executeToolBatch(tools: ToolUse[]): Promise<ToolResult[]> { /* ... */ }
}

// 4. Task（薄协调层）—— 仅负责组装与委派
class Task {
  private lifecycle: TaskLifecycleManager;
  private executor: TaskExecutor;
  private toolContext: ToolExecutionContext;

  constructor(deps: TaskDependencies) {
    this.executor = new TaskExecutor(deps.apiHandler, deps.toolOrchestrator, deps.contextManager);
    this.toolContext = new ToolExecutionContext(deps.orchestrator, deps.concurrency, deps.scheduler);
    this.lifecycle = new TaskLifecycleManager(this.executor, deps.persistence, deps.events);
  }
}
```

**涉及的文件列表**：
- `src/core/task/Task.ts`（主要拆分源）
- `src/core/task/TaskLifecycle.ts`（已有雏形，需扩展）
- `src/core/task/TaskMetrics.ts`（已有，保持）
- `src/core/task/modules/ToolExecutionOrchestrator.ts`（已有，需完成抽象收口）
- 新建 `src/core/task/TaskExecutor.ts`
- 新建 `src/core/task/TaskLifecycleManager.ts`
- 新建 `src/core/task/ToolExecutionContext.ts`

**预期收益**：
- Task.ts 从 5181 行降至 ~500 行（薄协调层）
- 每个拆分模块可独立单元测试
- 合并冲突大幅减少（不同职责修改不同文件）
- 新开发者理解成本显著降低

**注意事项/风险**：
- Task 内部状态共享较多（如 `abort` 标志、`consecutiveMistakeCount` 等），拆分时需明确状态归属，建议通过共享的 `TaskState` 对象传递
- 需要逐步迁移，每次迁移一个职责并确保测试通过，避免一次性大规模重写
- `dispose()` 中当前存在三次重复重置并发控制器的缺陷（P0 #7），应在迁移到 `TaskLifecycleManager` 时一并修复

---

#### A.2 ClineProvider.ts 拆分方案

**问题现状**：`ClineProvider.ts` 当前 3376 行，是一个"前端控制塔"，混合了 Webview 生命周期管理、任务创建/管理、配置与模式管理、MCP/Skills 初始化、遥测等职责。被 8+ 模块直接导入，是系统中最大的耦合中心。`handleModeSwitch` 等方法约 90 行，嵌套层级深。

**具体改进方案**：拆分为 3 个独立服务 + 1 个薄的 Webview Host：

```typescript
// 1. TaskCenter —— 任务管理中心，管理任务的创建、查询、切换
//    从 ClineProvider 中提取所有任务相关逻辑
class TaskCenter {
  private activeTasks: Map<string, Task> = new Map();
  private taskHistory: TaskHistoryManager;

  async createTask(config: TaskConfig): Promise<Task> { /* ... */ }
  async switchTask(taskId: string): Promise<void> { /* ... */ }
  async abortTask(taskId: string): Promise<void> { /* ... */ }
  getActiveTask(): Task | undefined { /* ... */ }
}

// 2. ModeConfigService —— 模式与配置管理
//    从 ClineProvider 中提取 handleModeSwitch、loadModeConfig、
//    getCustomModes 等逻辑
class ModeConfigService {
  async switchMode(modeId: string): Promise<ModeConfig> { /* ... */ }
  getAvailableModes(): ModeConfig[] { /* ... */ }
  validateModeTransition(from: string, to: string): boolean { /* ... */ }
}

// 3. WebviewHost —— 纯粹的 Webview 生命周期管理
//    仅负责 resolveWebviewView、消息路由、面板状态
class WebviewHost implements vscode.WebviewViewProvider {
  constructor(
    private taskCenter: TaskCenter,
    private modeService: ModeConfigService,
    private messageRouter: WebviewMessageRouter
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void { /* ... */ }

  // 消息路由：根据消息类型委派到不同服务
  private async handleMessage(message: WebviewMessage): Promise<void> {
    await this.messageRouter.route(message);
  }
}

// 4. WebviewMessageRouter —— 消息路由器
//    将 ClineProvider 中庞大的 switch-case 消息处理拆分为独立处理器
class WebviewMessageRouter {
  private handlers: Map<string, IMessageHandler> = new Map();

  register(type: string, handler: IMessageHandler): void { /* ... */ }
  async route(message: WebviewMessage): Promise<void> {
    const handler = this.handlers.get(message.type);
    if (handler) await handler.handle(message);
  }
}
```

**涉及的文件列表**：
- `src/core/webview/ClineProvider.ts`（主要拆分源）
- 新建 `src/core/task/TaskCenter.ts`
- 新建 `src/core/config/ModeConfigService.ts`
- 新建 `src/core/webview/WebviewHost.ts`
- 新建 `src/core/webview/WebviewMessageRouter.ts`
- 所有当前直接 `import { ClineProvider }` 的文件（需改为依赖接口或具体服务）

**预期收益**：
- ClineProvider.ts 从 3376 行降至 ~300 行（WebviewHost 薄壳）
- 解除 8+ 模块对 ClineProvider 的直接依赖
- 任务管理逻辑（TaskCenter）可独立于 UI 测试
- 模式配置逻辑（ModeConfigService）可独立于任务和 UI 测试

**注意事项/风险**：
- ClineProvider 目前是多个模块的"事实上的 ServiceLocator"，拆分时需梳理每个外部模块到底依赖 ClineProvider 的哪些具体能力，逐个替换
- Webview 消息处理中涉及大量状态交互，拆分 MessageRouter 时需确保事务一致性
- 建议先拆 TaskCenter（收益最大），再拆 ModeConfigService，最后处理 WebviewHost

---

#### A.3 McpHub.ts 拆分方案

**问题现状**：`McpHub.ts` 当前 2052 行，融合了 MCP 配置文件解析、三种传输协议（stdio/SSE/streamable HTTP）的连接建立、连接生命周期管理、资源/工具同步、UI 回调等职责。单个连接方法约 190 行，存在对 ClineProvider 的反向依赖。

**具体改进方案**：拆分为 3 个独立模块：

```typescript
// 1. McpConfigLoader —— 配置文件解析与监听
class McpConfigLoader {
  async loadConfig(configPath: string): Promise<McpServerConfig[]> { /* ... */ }
  watchConfigChanges(callback: (configs: McpServerConfig[]) => void): Disposable { /* ... */ }
  mergeConfigs(global: McpServerConfig[], project: McpServerConfig[]): McpServerConfig[] { /* ... */ }
}

// 2. TransportFactory —— 传输层工厂（策略模式）
interface ITransportStrategy {
  canHandle(config: McpServerConfig): boolean;
  createTransport(config: McpServerConfig): Promise<Transport>;
}

class StdioTransportStrategy implements ITransportStrategy { /* ... */ }
class SseTransportStrategy implements ITransportStrategy { /* ... */ }
class StreamableHttpTransportStrategy implements ITransportStrategy { /* ... */ }

class TransportFactory {
  private strategies: ITransportStrategy[] = [];

  register(strategy: ITransportStrategy): void {
    this.strategies.push(strategy);
  }

  async createTransport(config: McpServerConfig): Promise<Transport> {
    const strategy = this.strategies.find(s => s.canHandle(config));
    if (!strategy) throw new Error(`Unsupported transport: ${config.transportType}`);
    return strategy.createTransport(config);
  }
}

// 3. McpConnectionManager —— 连接生命周期管理
class McpConnectionManager {
  constructor(
    private transportFactory: TransportFactory,
    private statusSink: IMcpStatusSink  // 接口，而非直接依赖 ClineProvider
  ) {}

  async connect(config: McpServerConfig): Promise<McpConnection> { /* ... */ }
  async disconnect(serverId: string): Promise<void> { /* ... */ }
  async reconnect(serverId: string): Promise<void> { /* ... */ }
  getConnectionStatus(serverId: string): ConnectionStatus { /* ... */ }
}

// McpHub 退化为薄协调层
class McpHub {
  constructor(
    private configLoader: McpConfigLoader,
    private connectionManager: McpConnectionManager
  ) {}
}
```

**涉及的文件列表**：
- `src/services/mcp/McpHub.ts`（主要拆分源）
- `src/services/mcp/McpServerManager.ts`（需同步调整）
- 新建 `src/services/mcp/McpConfigLoader.ts`
- 新建 `src/services/mcp/transport/TransportFactory.ts`
- 新建 `src/services/mcp/transport/StdioTransportStrategy.ts`
- 新建 `src/services/mcp/transport/SseTransportStrategy.ts`
- 新建 `src/services/mcp/transport/StreamableHttpTransportStrategy.ts`
- 新建 `src/services/mcp/McpConnectionManager.ts`

**预期收益**：
- McpHub.ts 从 2052 行降至 ~300 行
- 传输策略可独立测试（mock Transport 接口）
- 新增传输类型仅需添加一个 Strategy 类，零侵入
- 通过 `IMcpStatusSink` 接口消除对 ClineProvider 的反向依赖

**注意事项/风险**：
- 三种传输协议的错误处理和重连逻辑差异较大，拆分时需仔细验证每种策略的异常路径
- 配置文件监听（FileWatcher）需确保在 McpConfigLoader 中正确管理生命周期
- 连接状态管理涉及并发场景（多个服务器同时连接/断开），需在 McpConnectionManager 中妥善处理竞态条件

---

### B. 循环依赖消除

#### B.1 core/webview ↔ core/task 循环依赖

**问题现状**：`ClineProvider.ts`（core/webview）与 `Task.ts`（core/task）互相导入——Task 在运行过程中需要通知 UI 更新（调用 ClineProvider 的方法），而 ClineProvider 需要创建和管理 Task 实例。这导致两个 5000+/3300+ 行的文件形成紧耦合，任何改动都可能需要同时修改两个文件。

**具体改进方案**：引入事件总线 + 接口抽象，打破双向直接导入：

```typescript
// 步骤 1：定义 Task 所需的 UI 通知接口（放在 core/task/ 目录下）
// src/core/task/interfaces/ITaskUINotifier.ts
interface ITaskUINotifier {
  postMessageToWebview(message: WebviewMessage): Promise<void>;
  updateTaskStatus(taskId: string, status: TaskStatus): void;
  showProgressNotification(taskId: string, progress: TaskProgress): void;
  requestUserApproval(taskId: string, request: ApprovalRequest): Promise<boolean>;
}

// 步骤 2：定义事件总线（放在 shared/ 或 core/events/）
// src/core/events/TaskEventBus.ts
type TaskEventType =
  | 'task:started' | 'task:completed' | 'task:failed' | 'task:aborted'
  | 'task:tool-executing' | 'task:tool-completed'
  | 'task:llm-response' | 'task:tokens-updated';

class TaskEventBus {
  private listeners: Map<TaskEventType, Set<TaskEventListener>> = new Map();

  on(event: TaskEventType, listener: TaskEventListener): Disposable {
    // 注册监听器，返回 Disposable 用于取消订阅
  }

  emit(event: TaskEventType, payload: TaskEventPayload): void {
    // 触发事件，通知所有监听者
  }
}

// 全局单例（或通过 DI 注入）
export const taskEventBus = new TaskEventBus();

// 步骤 3：Task 改为依赖接口和事件总线，而非直接导入 ClineProvider
class Task {
  constructor(
    private uiNotifier: ITaskUINotifier,  // 接口，非 ClineProvider 实现
    private eventBus: TaskEventBus
  ) {}

  private async onToolComplete(result: ToolResult): Promise<void> {
    this.eventBus.emit('task:tool-completed', { taskId: this.id, result });
    // 不再直接调用 this.clineProvider.postMessageToWebview(...)
  }
}

// 步骤 4：ClineProvider 实现 ITaskUINotifier 接口
class ClineProvider implements ITaskUINotifier {
  async postMessageToWebview(message: WebviewMessage): Promise<void> { /* ... */ }
  // ...其他接口方法
}
```

**涉及的文件列表**：
- `src/core/task/Task.ts`（移除对 ClineProvider 的直接导入）
- `src/core/webview/ClineProvider.ts`（实现 ITaskUINotifier 接口）
- 新建 `src/core/task/interfaces/ITaskUINotifier.ts`
- 新建 `src/core/events/TaskEventBus.ts`
- 所有通过 Task 间接依赖 ClineProvider 的文件

**预期收益**：
- 消除系统中最严重的循环依赖
- Task 模块可独立于 Webview 进行单元测试（传入 mock ITaskUINotifier）
- 为未来将 Task 逻辑迁移到 `packages/core`（跨平台复用）扫清障碍
- 事件总线模式允许多个消费者订阅任务事件（如遥测、日志、调试工具）

**注意事项/风险**：
- 事件总线引入了间接性，调试时需要追踪事件流，建议添加事件日志中间件
- 需要确保事件的发送和处理顺序不影响现有业务逻辑（某些通知可能有顺序依赖）
- 迁移过程中可先保留旧的直接调用作为 fallback，逐步替换

---

#### B.2 services/mcp ↔ core/webview 循环依赖

**问题现状**：`McpHub.ts` 和 `McpServerManager.ts`（services/mcp）反向依赖 `ClineProvider`（core/webview），用于在 MCP 连接状态变化时通知 UI 更新。这违反了分层架构原则（服务层不应依赖 UI 层）。

**具体改进方案**：定义 `IMcpStatusSink` 接口，实现依赖反转：

```typescript
// 步骤 1：在 services/mcp/ 目录下定义接口
// src/services/mcp/interfaces/IMcpStatusSink.ts
interface IMcpStatusSink {
  onServerStatusChanged(serverId: string, status: McpServerStatus): void;
  onServerListUpdated(servers: McpServerInfo[]): void;
  onToolsDiscovered(serverId: string, tools: McpToolInfo[]): void;
  onConnectionError(serverId: string, error: McpConnectionError): void;
}

// 步骤 2：McpHub 依赖接口而非 ClineProvider
class McpHub {
  constructor(
    private statusSink: IMcpStatusSink,  // 接口注入
    // ... 其他依赖
  ) {}

  private async onConnectionEstablished(serverId: string): Promise<void> {
    // 原来：this.clineProvider.postMessageToWebview(...)
    // 改为：
    this.statusSink.onServerStatusChanged(serverId, McpServerStatus.Connected);
  }
}

// 步骤 3：ClineProvider 实现该接口
class ClineProvider implements IMcpStatusSink {
  onServerStatusChanged(serverId: string, status: McpServerStatus): void {
    this.postMessageToWebview({ type: 'mcpServerStatus', serverId, status });
  }
  // ... 其他接口方法
}

// 步骤 4：在初始化时注入
const mcpHub = new McpHub(clineProvider as IMcpStatusSink, /* ... */);
```

**涉及的文件列表**：
- `src/services/mcp/McpHub.ts`（移除对 ClineProvider 的直接导入）
- `src/services/mcp/McpServerManager.ts`（同上）
- `src/core/webview/ClineProvider.ts`（实现 IMcpStatusSink）
- 新建 `src/services/mcp/interfaces/IMcpStatusSink.ts`

**预期收益**：
- 服务层不再依赖 UI 层，符合分层架构原则
- MCP 模块可独立测试（传入 mock IMcpStatusSink）
- 未来可轻松替换 UI 通知方式（如命令行界面、远程通知等）

**注意事项/风险**：
- 改动范围相对可控，建议在 B.1 之前或同时执行
- 需确保 McpServerManager 中所有对 ClineProvider 的引用都迁移到接口

---

### C. 分层架构修复

#### C.1 shared → core 反向依赖修复

**问题现状**：`shared/modes.ts` 直接导入了 `core/prompts` 中的内容（如提示词相关常量），破坏了共享层的独立性。shared 层本应是所有层都可安全依赖的最底层，不应有向上层的依赖。

**具体改进方案**：将被 shared 层需要的内容下移到 shared 层：

```typescript
// 步骤 1：识别 shared/modes.ts 从 core/prompts 导入的具体内容
// 通常是模式描述文本、提示词片段等常量

// 步骤 2：将这些常量迁移到 shared 层
// src/shared/mode-constants.ts
export const MODE_PROMPT_FRAGMENTS = {
  code: "You are a coding assistant...",
  architect: "You are a software architect...",
  ask: "You are a helpful assistant...",
  // ...
} as const;

// 步骤 3：core/prompts 改为从 shared 层导入这些常量
// src/core/prompts/sections/mode-section.ts
import { MODE_PROMPT_FRAGMENTS } from "../../shared/mode-constants";

// 步骤 4：shared/modes.ts 移除对 core/ 的导入
// src/shared/modes.ts
import { MODE_PROMPT_FRAGMENTS } from "./mode-constants";  // 同层导入
```

**涉及的文件列表**：
- `src/shared/modes.ts`（移除对 core 的导入）
- `src/core/prompts/` 相关文件（改为从 shared 导入常量）
- 新建 `src/shared/mode-constants.ts`

**预期收益**：
- shared 层恢复独立性，可安全被所有层依赖
- 为 shared 层作为独立 npm 包发布奠定基础

**注意事项/风险**：
- 需仔细检查移动的常量是否有其他 core 层依赖，避免引入新的反向依赖
- 如果常量涉及复杂类型定义，类型定义也需一并下移

---

#### C.2 api → core 反向依赖修复

**问题现状**：9 个 API Provider 文件直接导入 `core/assistant-message` 模块来解析工具调用，导致 API 层与核心实现紧耦合。API 层本应仅依赖 shared 层和自身内部模块。

**具体改进方案**：定义 `IToolCallParser` 接口，通过依赖反转消除反向依赖：

```typescript
// 步骤 1：在 api 层定义解析接口
// src/api/interfaces/IToolCallParser.ts
interface IToolCallParser {
  parseToolCalls(content: string): ParsedToolCall[];
  isToolCallComplete(partial: string): boolean;
}

interface ParsedToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
  rawContent: string;
}

// 步骤 2：在 core 层实现该接口
// src/core/assistant-message/ToolCallParserImpl.ts
class ToolCallParserImpl implements IToolCallParser {
  parseToolCalls(content: string): ParsedToolCall[] {
    // 将现有的 assistant-message 解析逻辑封装在此
  }
}

// 步骤 3：Provider 改为依赖接口
// src/api/providers/openai.ts（示例）
class OpenAiHandler implements ApiHandler {
  constructor(
    private options: ApiHandlerOptions,
    private toolCallParser?: IToolCallParser  // 可选注入
  ) {}
}

// 步骤 4：在组装层注入实现
// src/api/index.ts
const parser = new ToolCallParserImpl();
const handler = new OpenAiHandler(options, parser);
```

**涉及的文件列表**：
- 9 个直接导入 `core/assistant-message` 的 Provider 文件
- 新建 `src/api/interfaces/IToolCallParser.ts`
- 新建 `src/core/assistant-message/ToolCallParserImpl.ts`
- `src/api/index.ts`（组装注入点）

**预期收益**：
- API 层不再依赖 core 层内部实现
- Provider 可在不引入 core 模块的情况下独立测试
- 为 API 层独立打包为 npm 包创造条件

**注意事项/风险**：
- 部分 Provider 可能使用了 `assistant-message` 中较深层的功能，需逐个排查
- 接口设计需覆盖所有 9 个 Provider 的使用场景，避免频繁修改接口

---

#### C.3 utils → core 反向依赖修复

**问题现状**：`utils/` 层中存在对 `core/` 层模块的导入，违反了工具层不应依赖业务核心层的原则。

**具体改进方案**：

```typescript
// 方案一：将 utils 中使用的 core 类型定义下移到 shared/types/
// 如果 utils 只是需要类型定义，将类型移到 shared 即可

// 方案二：如果 utils 中的某些功能确实属于 core 层逻辑，
// 则将该 util 函数迁移到 core 层对应模块中

// 具体步骤：
// 1. 用 grep 找出所有 utils/ -> core/ 的导入
// 2. 对每个导入分类：是纯类型导入还是运行时依赖
// 3. 纯类型导入 → 将类型定义下移到 shared/types/
// 4. 运行时依赖 → 将该 util 函数迁移到 core/ 对应模块
```

**涉及的文件列表**：
- `src/utils/` 中导入 core 的文件（需通过 grep 具体排查）
- `src/shared/types/`（可能需新建类型文件）

**预期收益**：
- utils 层恢复为纯工具层，可被任何层安全依赖
- 依赖关系图更清晰

**注意事项/风险**：
- 迁移类型时需确保不破坏现有的类型推导链

---

### D. API 提供商层改进

#### D.1 提供商注册表替代 switch 语句

**问题现状**：`src/api/index.ts` 中的工厂函数包含 25+ 分支的 switch 语句，每新增一个提供商需修改此文件及其他 7+ 处位置，严重违反开闭原则。

**具体改进方案**：实现 ProviderRegistry 注册表模式：

```typescript
// src/api/registry/ProviderRegistry.ts
interface ProviderRegistration {
  id: string;
  displayName: string;
  factory: (options: ApiHandlerOptions) => ApiHandler;
  configSchema?: ProviderConfigSchema;
  capabilities: ProviderCapabilities;
}

class ProviderRegistry {
  private providers: Map<string, ProviderRegistration> = new Map();

  register(registration: ProviderRegistration): void {
    if (this.providers.has(registration.id)) {
      throw new Error(`Provider '${registration.id}' already registered`);
    }
    this.providers.set(registration.id, registration);
  }

  createHandler(providerId: string, options: ApiHandlerOptions): ApiHandler {
    const registration = this.providers.get(providerId);
    if (!registration) {
      throw new Error(`Unknown provider: ${providerId}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    return registration.factory(options);
  }

  getAvailableProviders(): ProviderRegistration[] {
    return [...this.providers.values()];
  }

  getCapabilities(providerId: string): ProviderCapabilities | undefined {
    return this.providers.get(providerId)?.capabilities;
  }
}

// 全局单例
export const providerRegistry = new ProviderRegistry();

// 各 Provider 自注册（每个 Provider 文件末尾）
// src/api/providers/openai.ts
providerRegistry.register({
  id: 'openai',
  displayName: 'OpenAI',
  factory: (options) => new OpenAiHandler(options),
  capabilities: { streaming: true, vision: true, toolCalling: true },
});

// src/api/providers/anthropic.ts
providerRegistry.register({
  id: 'anthropic',
  displayName: 'Anthropic',
  factory: (options) => new AnthropicHandler(options),
  capabilities: { streaming: true, vision: true, toolCalling: true },
});

// src/api/index.ts —— 工厂函数简化为一行
export function buildApiHandler(options: ApiHandlerOptions): ApiHandler {
  return providerRegistry.createHandler(options.apiProvider, options);
}
```

**涉及的文件列表**：
- `src/api/index.ts`（简化工厂函数）
- 新建 `src/api/registry/ProviderRegistry.ts`
- 所有 37 个 Provider 文件（添加自注册代码）
- `src/shared/api.ts` 或相关类型定义（添加 `ProviderCapabilities` 类型）

**预期收益**：
- 新增提供商仅需创建 Provider 文件并添加注册代码，改动从 7+ 处降至 1 处
- 工厂函数从 25+ 分支降至 0 分支
- 可在运行时动态查询可用提供商及其能力
- 符合开闭原则

**注意事项/风险**：
- 自注册依赖模块加载顺序，需确保所有 Provider 文件在首次调用 `createHandler` 前被加载（可通过显式 import 或动态 require 解决）
- 需要一个入口文件（如 `src/api/providers/index.ts`）统一 import 所有 Provider 以触发注册

---

#### D.2 重试与错误分类框架

**问题现状**：API 层完全缺少指数退避重试机制，429 速率限制和 500 服务器错误直接传播给用户。高频调用场景下，服务中断时无法自动恢复，用户体验极差。

**具体改进方案**：实现通用重试框架，支持指数退避和错误分类：

```typescript
// src/api/retry/ApiRetryStrategy.ts
interface RetryConfig {
  maxRetries: number;           // 默认 3
  initialDelayMs: number;       // 默认 1000
  maxDelayMs: number;           // 默认 60000
  backoffMultiplier: number;    // 默认 2
  jitterFactor: number;         // 默认 0.1（添加随机抖动避免雷群效应）
}

// 错误分类枚举
enum ApiErrorCategory {
  Retryable,         // 429, 500, 502, 503, 504, 网络超时
  NonRetryable,      // 400, 401, 403, 404
  RateLimited,       // 429（特殊处理：使用 Retry-After 头）
  AuthenticationError, // 401, 403
}

function classifyError(error: unknown): ApiErrorCategory {
  if (error instanceof ApiError) {
    if (error.status === 429) return ApiErrorCategory.RateLimited;
    if (error.status === 401 || error.status === 403) return ApiErrorCategory.AuthenticationError;
    if (error.status >= 500) return ApiErrorCategory.Retryable;
    return ApiErrorCategory.NonRetryable;
  }
  if (isNetworkError(error)) return ApiErrorCategory.Retryable;
  return ApiErrorCategory.NonRetryable;
}

// 重试执行器
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const category = classifyError(error);

      if (category === ApiErrorCategory.NonRetryable ||
          category === ApiErrorCategory.AuthenticationError) {
        throw error;  // 不可重试，直接抛出
      }

      if (attempt === config.maxRetries) break;

      let delay: number;
      if (category === ApiErrorCategory.RateLimited) {
        // 优先使用 Retry-After 头
        delay = getRetryAfterMs(error) ?? calculateBackoff(attempt, config);
      } else {
        delay = calculateBackoff(attempt, config);
      }

      await sleep(delay);
    }
  }
  throw lastError;
}

function calculateBackoff(attempt: number, config: RetryConfig): number {
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const jitter = baseDelay * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.min(baseDelay + jitter, config.maxDelayMs);
}

// 在 Provider 基类中集成
// src/api/providers/base-provider.ts
abstract class BaseProvider implements ApiHandler {
  protected retryConfig: RetryConfig;

  async *createMessage(systemPrompt: string, messages: Message[]): ApiStream {
    yield* withRetryStream(() => this.doCreateMessage(systemPrompt, messages), this.retryConfig);
  }

  protected abstract doCreateMessage(systemPrompt: string, messages: Message[]): ApiStream;
}
```

**涉及的文件列表**：
- 新建 `src/api/retry/ApiRetryStrategy.ts`
- 新建 `src/api/retry/error-classifier.ts`
- `src/api/providers/base-provider.ts`（如存在基类）或各 Provider 文件
- `src/shared/api.ts`（添加 RetryConfig 类型到 ApiHandlerOptions）

**预期收益**：
- 429/500 错误自动重试，用户无感知
- 支持 `Retry-After` 头的智能延迟
- 错误分类统一，不同类型错误有不同处理策略
- 可按提供商配置不同的重试策略

**注意事项/风险**：
- 流式响应（AsyncGenerator）的重试比普通 Promise 更复杂，需要处理部分响应已消费的情况
- 重试可能导致重复请求和额外费用，需在配置中提供关闭选项
- 某些提供商有自己的 SDK 内置重试，需避免双重重试

---

#### D.3 Token 计数准确性改进

**问题现状**：所有提供商的 Token 计数都使用 tiktoken（OpenAI 的分词器），但不同提供商的分词算法差异显著，导致精度偏差可达 ±15%。这影响成本计算的准确性和上下文窗口的预算控制。

**具体改进方案**：为主要提供商实现 native token counting：

```typescript
// src/api/token-counting/ITokenCounter.ts
interface ITokenCounter {
  countTokens(text: string): number;
  countMessageTokens(messages: Message[]): number;
  getModelTokenLimit(modelId: string): number;
}

// src/api/token-counting/TokenCounterFactory.ts
class TokenCounterFactory {
  private counters: Map<string, ITokenCounter> = new Map();

  register(providerId: string, counter: ITokenCounter): void {
    this.counters.set(providerId, counter);
  }

  getCounter(providerId: string): ITokenCounter {
    // 优先返回 native counter，fallback 到 tiktoken
    return this.counters.get(providerId) ?? this.defaultTiktokenCounter;
  }
}

// 为 Anthropic 实现精确计数（使用其 API 的 token counting endpoint）
class AnthropicTokenCounter implements ITokenCounter {
  countTokens(text: string): number {
    // 使用 Anthropic 的分词规则
    // 可以缓存结果以减少 API 调用
  }
}

// 为 Google/Gemini 实现精确计数
class GeminiTokenCounter implements ITokenCounter {
  countTokens(text: string): number {
    // 使用 Gemini 的 countTokens API
  }
}
```

**涉及的文件列表**：
- `src/utils/countTokens.ts`（重构为使用 TokenCounterFactory）
- `src/api/providers/base-provider.ts`（注入 TokenCounter）
- 新建 `src/api/token-counting/ITokenCounter.ts`
- 新建 `src/api/token-counting/TokenCounterFactory.ts`
- 新建 `src/api/token-counting/AnthropicTokenCounter.ts`
- 新建 `src/api/token-counting/GeminiTokenCounter.ts`

**预期收益**：
- 主要提供商的 Token 计数精度从 ±15% 提升到 ±2%
- 成本计算更准确，预算控制更可靠
- 上下文窗口利用率提升（不再因过度预估而浪费空间）

**注意事项/风险**：
- 部分提供商的 native counting 可能需要额外 API 调用（有延迟和成本）
- 建议实现缓存层，对相同内容不重复计数
- 兜底方案（tiktoken）必须保留，确保未注册提供商仍能工作

---

### E. 工具系统改进

#### E.1 参数验证统一化

**问题现状**：工具系统中存在 3 种不同的参数验证模式——部分工具使用 if 判断、部分使用正则校验、部分使用 schema 验证，导致行为不可预测、维护困难。

**具体改进方案**：引入统一的 Schema 驱动参数验证框架：

```typescript
// src/core/tools/validation/ToolParamSchema.ts
interface ToolParamSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path';
  required: boolean;
  description: string;
  validation?: {
    pattern?: RegExp;          // 正则校验
    minLength?: number;
    maxLength?: number;
    enum?: string[];           // 枚举值列表
    custom?: (value: unknown) => ValidationResult;  // 自定义校验
  };
  sanitize?: (value: string) => string;  // 输入净化
}

interface ToolSchema {
  toolName: string;
  params: ToolParamSchema[];
}

// 统一验证器
class ToolParamValidator {
  validate(schema: ToolSchema, params: Record<string, unknown>): ValidationResult {
    const errors: ValidationError[] = [];

    for (const paramSchema of schema.params) {
      const value = params[paramSchema.name];

      // 必填检查
      if (paramSchema.required && (value === undefined || value === '')) {
        errors.push({ param: paramSchema.name, message: `Required parameter '${paramSchema.name}' is missing` });
        continue;
      }

      // 类型检查
      if (value !== undefined && !this.checkType(value, paramSchema.type)) {
        errors.push({ param: paramSchema.name, message: `Expected type '${paramSchema.type}'` });
      }

      // 自定义校验
      if (value !== undefined && paramSchema.validation?.custom) {
        const result = paramSchema.validation.custom(value);
        if (!result.valid) errors.push({ param: paramSchema.name, message: result.message });
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// 各工具声明自己的 Schema（示例）
const readFileSchema: ToolSchema = {
  toolName: 'read_file',
  params: [
    { name: 'path', type: 'path', required: true, description: 'File path to read' },
    { name: 'start_line', type: 'number', required: false, description: 'Start line number' },
    { name: 'end_line', type: 'number', required: false, description: 'End line number' },
  ],
};
```

**涉及的文件列表**：
- 新建 `src/core/tools/validation/ToolParamSchema.ts`
- 新建 `src/core/tools/validation/ToolParamValidator.ts`
- 所有工具实现文件（添加 Schema 声明，替换现有验证逻辑）

**预期收益**：
- 参数验证行为一致、可预测
- 新增工具时只需声明 Schema，无需手写验证逻辑
- 验证错误信息格式统一，便于调试和用户反馈
- Schema 可复用于生成工具文档和 LLM 提示词

**注意事项/风险**：
- 需逐个工具迁移，确保不改变现有验证行为
- 路径类型（`path`）的验证涉及跨平台差异（Windows/Linux/macOS）

---

#### E.2 安全审批机制加固

**问题现状**：
1. **bypass 权限模式**：允许任何工具绕过权限检查，且无安全警告或审计日志，是 P0 安全风险。
2. **命令执行安全**：`execute_command` 工具缺少对危险操作（如 `rm -rf`、`format`、`DROP TABLE` 等）的检查。

**具体改进方案**：

```typescript
// 方案一：bypass 权限加固
// src/core/tools/permissions/BypassSafetyGuard.ts
class BypassSafetyGuard {
  private static readonly DANGEROUS_TOOLS = ['execute_command', 'write_to_file', 'delete_file'];

  static validateBypass(toolName: string, context: ToolExecutionContext): BypassDecision {
    if (this.DANGEROUS_TOOLS.includes(toolName)) {
      // 高危工具即使在 bypass 模式下也需要确认
      return {
        allowed: false,
        requiresExplicitConfirmation: true,
        warning: `Tool '${toolName}' is marked as dangerous and cannot be bypassed without explicit confirmation.`,
      };
    }

    // 记录审计日志
    AuditLogger.log({
      event: 'permission_bypass',
      tool: toolName,
      timestamp: Date.now(),
      taskId: context.taskId,
    });

    return { allowed: true };
  }
}

// 方案二：命令执行安全检查
// src/core/tools/security/CommandSafetyChecker.ts
class CommandSafetyChecker {
  private static readonly DANGEROUS_PATTERNS: DangerousPattern[] = [
    { pattern: /\brm\s+(-[rf]+\s+)*\//, level: 'critical', description: 'Recursive delete from root' },
    { pattern: /\brm\s+-rf\b/, level: 'high', description: 'Force recursive delete' },
    { pattern: /\bformat\s+[a-zA-Z]:/, level: 'critical', description: 'Disk format' },
    { pattern: /\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i, level: 'high', description: 'Destructive SQL' },
    { pattern: /\bchmod\s+777\b/, level: 'medium', description: 'Overly permissive chmod' },
    { pattern: /\b(curl|wget)\b.*\|\s*(bash|sh)\b/, level: 'critical', description: 'Remote code execution' },
    { pattern: /\b>\s*\/dev\/sd[a-z]/, level: 'critical', description: 'Direct disk write' },
  ];

  static check(command: string): CommandSafetyResult {
    const violations = this.DANGEROUS_PATTERNS
      .filter(p => p.pattern.test(command))
      .map(p => ({ level: p.level, description: p.description }));

    if (violations.some(v => v.level === 'critical')) {
      return { safe: false, blocked: true, violations, message: 'Command blocked: contains critical safety violation' };
    }

    if (violations.length > 0) {
      return { safe: false, blocked: false, violations, requiresApproval: true,
        message: `Command requires approval: ${violations.map(v => v.description).join(', ')}` };
    }

    return { safe: true, blocked: false, violations: [] };
  }
}
```

**涉及的文件列表**：
- `src/core/tools/` 权限系统相关文件
- `src/core/tools/implementations/execute_command` 相关文件
- 新建 `src/core/tools/permissions/BypassSafetyGuard.ts`
- 新建 `src/core/tools/security/CommandSafetyChecker.ts`
- 新建 `src/core/tools/security/AuditLogger.ts`

**预期收益**：
- 消除 bypass 权限的安全漏洞
- 阻止用户通过工具执行破坏性命令
- 审计日志为安全事件追踪提供基础
- 分级处理（blocked/requiresApproval/safe）平衡安全与便利

**注意事项/风险**：
- 危险命令模式列表需要持续维护和更新
- 正则匹配可能产生误报（如合法的 `rm` 命令），需要提供用户确认机制而非一刀切拦截
- bypass 模式可能在测试/开发场景中有合理用途，需保留显式确认路径

---

#### E.3 编辑工具整合

**问题现状**：当前存在 `edit`、`edit_file`、`search_replace` 三个功能高度重叠的编辑工具，LLM 在选择使用哪个工具时经常混淆，用户也难以理解三者的区别。

**具体改进方案**：

```typescript
// 方案：保留 1 个主编辑工具 + 明确的模式切换
// 建议保留 search_replace 作为主编辑工具（语义最清晰），
// edit 和 edit_file 标记为 deprecated 并在提示词中移除

// 步骤 1：在工具注册中标记废弃
// src/core/tools/registry.ts
toolRegistry.register({
  name: 'edit',
  deprecated: true,
  replacedBy: 'search_replace',
  // 在过渡期间仍可使用，但在 LLM 提示词中不再展示
});

// 步骤 2：在 search_replace 中增强功能，覆盖 edit/edit_file 的独特能力
// 如果 edit 支持 line-range 编辑，将该能力合并到 search_replace
// 如果 edit_file 支持全文替换，将该能力作为 search_replace 的一种模式

// 步骤 3：更新提示词中的工具描述，仅包含 search_replace
// src/core/prompts/sections/tools-section.ts
```

**涉及的文件列表**：
- `src/core/tools/implementations/` 中 edit、edit_file、search_replace 相关文件
- `src/core/prompts/sections/` 工具描述相关文件
- 工具注册表相关文件

**预期收益**：
- LLM 工具选择准确率提升（消除歧义）
- 维护成本降低（从维护 3 个编辑工具降至 1 个）
- 用户体验统一

**注意事项/风险**：
- 需要分析三个工具的功能差异，确保合并后不丢失任何关键能力
- 废弃过程需要一个过渡期，旧工具仍需工作但不再推荐
- 需更新所有涉及编辑工具的测试用例

---

### F. 提示词系统改进

#### F.1 业务逻辑与提示词生成分离

**问题现状**：提示词系统中大量文件混杂了业务逻辑——`cangjie-context.ts`（3134 行）内置完整的错误分析引擎和 import 依赖解析器、`custom-instructions.ts`（629 行）包含文件 I/O 操作、`multi-file-context.ts`（531 行）混杂 import 解析与编辑器集成代码。提示词文件应仅负责"根据输入数据生成文本"，不应包含数据获取和分析逻辑。

**具体改进方案**：将业务逻辑提取为独立服务，提示词生成仅接收已处理的数据：

```typescript
// 步骤 1：从 cangjie-context.ts 中提取错误分析引擎
// src/services/cangjie/CangjieErrorAnalyzer.ts
class CangjieErrorAnalyzer {
  analyze(diagnostics: Diagnostic[], sourceCode: string): ErrorAnalysisResult {
    // 原 cangjie-context.ts 中的错误分析逻辑（约 1500+ 行）
    // 包括：错误分类、错误链追踪、修复建议生成
  }
}

// src/services/cangjie/CangjieDependencyResolver.ts
class CangjieDependencyResolver {
  resolveImports(filePath: string): ImportGraph {
    // 原 cangjie-context.ts 中的 import 解析逻辑
  }
}

// 步骤 2：cangjie-context.ts 简化为纯模板生成
// src/core/prompts/sections/cangjie-context.ts（从 3134 行降至 ~300 行）
function generateCangjieContextSection(data: CangjieContextData): string {
  // 仅负责将已分析的数据格式化为提示词文本
  const { errors, imports, projectConfig } = data;
  return `
## Cangjie Project Context
${formatProjectConfig(projectConfig)}
${formatErrorAnalysis(errors)}
${formatDependencyGraph(imports)}
  `.trim();
}

// 步骤 3：从 custom-instructions.ts 中提取文件 I/O
// src/services/rules/RuleFileManager.ts
class RuleFileManager {
  async loadRuleFiles(projectRoot: string): Promise<RuleSet> {
    // 原 custom-instructions.ts 中的文件读取逻辑
    // 从 .clinerules、.cursorrules、.njust-ai/ 等位置加载规则
  }
}

// custom-instructions.ts 简化
function generateCustomInstructionsSection(rules: RuleSet): string {
  // 纯文本生成，不涉及文件 I/O
}

// 步骤 4：从 multi-file-context.ts 中提取 import 解析和编辑器集成
// src/services/context/ImportContextResolver.ts
class ImportContextResolver {
  async resolveEditContext(openFiles: string[]): Promise<MultiFileContext> {
    // 原 multi-file-context.ts 中的 import 解析与编辑器集成逻辑
  }
}
```

**涉及的文件列表**：
- `src/core/prompts/sections/cangjie-context.ts`（大幅简化）
- `src/core/prompts/sections/custom-instructions.ts`（简化）
- `src/core/prompts/sections/multi-file-context.ts`（简化）
- 新建 `src/services/cangjie/CangjieErrorAnalyzer.ts`
- 新建 `src/services/cangjie/CangjieDependencyResolver.ts`
- 新建 `src/services/rules/RuleFileManager.ts`
- 新建 `src/services/context/ImportContextResolver.ts`
- `src/core/prompts/system.ts`（调整调用方式）

**预期收益**：
- cangjie-context.ts 从 3134 行降至 ~300 行
- 业务逻辑服务可独立单元测试（无需构造完整提示词上下文）
- 提示词生成函数变为纯函数（输入数据 → 输出文本），易于测试和调试
- 错误分析引擎可被其他模块复用（如诊断面板、代码操作等）

**注意事项/风险**：
- cangjie-context.ts 内部状态较多，提取时需仔细管理状态边界
- 提取后需确保数据传递的完整性（提示词生成函数需要的所有数据都由服务层准备好）
- 建议逐个文件提取，先从 custom-instructions.ts（最简单）开始

---

#### F.2 参数列表重构（PromptGenerationConfig 对象）

**问题现状**：`SYSTEM_PROMPT()` 入口函数有 13 个参数，调用复杂、不易理解、难以扩展（每添加一个新功能可能需要增加参数）。

**具体改进方案**：封装为上下文对象模式：

```typescript
// src/core/prompts/types/PromptGenerationConfig.ts
interface PromptGenerationConfig {
  // 模式与角色
  mode: ModeConfig;
  customInstructions?: string;
  preferredLanguage?: string;

  // 工具与能力
  availableTools: ToolDefinition[];
  mcpServers?: McpServerInfo[];
  diffStrategy?: DiffStrategy;

  // 上下文信息
  projectContext?: ProjectContext;
  openFiles?: string[];
  workspaceRoot?: string;

  // 模型能力
  modelCapabilities: ModelCapabilities;
  supportsImages?: boolean;
  supportsComputerUse?: boolean;

  // 令牌预算
  tokenBudget?: TokenBudgetConfig;
}

// 修改前：
function SYSTEM_PROMPT(
  mode: string,
  customInstructions: string,
  tools: ToolDef[],
  mcpServers: McpServer[],
  diffStrategy: string,
  projectContext: any,
  openFiles: string[],
  workspaceRoot: string,
  modelCaps: ModelCaps,
  supportsImages: boolean,
  supportsComputerUse: boolean,
  tokenBudget: number,
  preferredLanguage: string
): string { /* ... */ }

// 修改后：
function SYSTEM_PROMPT(config: PromptGenerationConfig): string {
  const sections = buildSections(config);
  return sections
    .sort((a, b) => a.priority - b.priority)
    .map(s => s.content)
    .join('\n\n');
}
```

**涉及的文件列表**：
- `src/core/prompts/system.ts`（修改函数签名）
- 新建 `src/core/prompts/types/PromptGenerationConfig.ts`
- 所有调用 `SYSTEM_PROMPT()` 的文件（更新调用方式）

**预期收益**：
- 函数签名清晰，新增功能只需在 Config 中添加可选字段
- 调用方可通过 IDE 自动补全发现所有可用选项
- 便于构建 Builder 模式或从配置文件加载

**注意事项/风险**：
- 需要同时更新所有调用点，建议通过 TypeScript 编译器检查确保无遗漏
- 过渡期可同时支持旧参数列表（adapter 函数），逐步迁移

---

#### F.3 提示词版本管理

**问题现状**：提示词内容的变更无法追踪和回滚，无法进行 A/B 测试来评估不同提示词版本的效果差异。提示词的修改分散在多个文件中，缺乏版本标识。

**具体改进方案**：

```typescript
// src/core/prompts/versioning/PromptVersion.ts
interface SectionVersion {
  id: string;           // Section 标识，如 "tools-section"
  version: string;      // 语义化版本，如 "2.1.0"
  hash: string;         // 内容 hash，用于缓存破裂检测
  changelog?: string;   // 变更说明
}

// 在每个 Section 文件中声明版本
// src/core/prompts/sections/tools-section.ts
export const TOOLS_SECTION_VERSION: SectionVersion = {
  id: 'tools-section',
  version: '2.1.0',
  hash: computeHash(toolsSectionContent),
  changelog: '添加 search_replace 工具描述，废弃 edit/edit_file',
};

// 版本注册表
// src/core/prompts/versioning/PromptVersionRegistry.ts
class PromptVersionRegistry {
  private versions: Map<string, SectionVersion> = new Map();

  register(version: SectionVersion): void {
    this.versions.set(version.id, version);
  }

  getCompositeVersion(): string {
    // 生成整体提示词的复合版本标识
    const parts = [...this.versions.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(v => `${v.id}@${v.version}`);
    return computeHash(parts.join('|'));
  }

  getVersionReport(): VersionReport {
    return {
      compositeHash: this.getCompositeVersion(),
      sections: [...this.versions.values()],
      generatedAt: new Date().toISOString(),
    };
  }
}

// 在生成提示词时附带版本信息（用于日志和调试）
function SYSTEM_PROMPT(config: PromptGenerationConfig): PromptResult {
  const content = buildPromptContent(config);
  return {
    content,
    version: promptVersionRegistry.getVersionReport(),
  };
}
```

**涉及的文件列表**：
- `src/core/prompts/system.ts`（添加版本信息输出）
- 所有 Section 文件（添加版本声明）
- 新建 `src/core/prompts/versioning/PromptVersion.ts`
- 新建 `src/core/prompts/versioning/PromptVersionRegistry.ts`

**预期收益**：
- 提示词变更可追踪（哪个 Section 在什么时候改了什么）
- 支持通过复合版本 hash 进行缓存破裂检测
- 为 A/B 测试提供版本标识基础
- 出现 LLM 行为异常时可快速定位是否与提示词变更相关

**注意事项/风险**：
- 版本号需要开发者手动维护，可能出现遗忘更新的情况——建议在 CI 中添加检查（内容 hash 变化但版本号未更新时告警）
- 版本信息不应作为提示词内容发送给 LLM，仅用于内部追踪

---

### G. 依赖注入与可测试性

#### G.1 引入轻量级 DI 容器或工厂模式

**问题现状**：项目中核心类（Task、ClineProvider、McpHub）通过直接 `new` 创建依赖对象，无法在测试中替换为 mock 实现。构造函数参数众多且类型为具体类而非接口，导致测试时必须构造完整的依赖链。

**具体改进方案**：引入轻量级 DI 方案（不需要 InversifyJS 等重量级框架，使用简单的手动 DI 容器即可）：

```typescript
// src/core/di/ServiceContainer.ts
class ServiceContainer {
  private services: Map<string, any> = new Map();
  private factories: Map<string, () => any> = new Map();

  // 注册单例
  registerSingleton<T>(token: string, instance: T): void {
    this.services.set(token, instance);
  }

  // 注册工厂（每次 resolve 创建新实例）
  registerFactory<T>(token: string, factory: () => T): void {
    this.factories.set(token, factory);
  }

  // 解析依赖
  resolve<T>(token: string): T {
    if (this.services.has(token)) return this.services.get(token);
    if (this.factories.has(token)) return this.factories.get(token)!();
    throw new Error(`Service '${token}' not registered`);
  }
}

// 使用 Token 常量避免魔术字符串
// src/core/di/tokens.ts
export const ServiceTokens = {
  TaskCenter: 'TaskCenter',
  McpHub: 'McpHub',
  ProviderRegistry: 'ProviderRegistry',
  EventBus: 'EventBus',
  ConfigService: 'ConfigService',
  AuditLogger: 'AuditLogger',
} as const;

// 应用启动时组装
// src/core/di/container-setup.ts
function createProductionContainer(): ServiceContainer {
  const container = new ServiceContainer();

  container.registerSingleton(ServiceTokens.EventBus, new TaskEventBus());
  container.registerSingleton(ServiceTokens.ProviderRegistry, new ProviderRegistry());
  container.registerSingleton(ServiceTokens.ConfigService, new ModeConfigService());
  container.registerFactory(ServiceTokens.TaskCenter, () =>
    new TaskCenter(container.resolve(ServiceTokens.EventBus))
  );

  return container;
}

// 测试中替换为 mock
function createTestContainer(): ServiceContainer {
  const container = new ServiceContainer();

  container.registerSingleton(ServiceTokens.EventBus, new MockEventBus());
  container.registerSingleton(ServiceTokens.ProviderRegistry, new MockProviderRegistry());
  // ...

  return container;
}
```

**涉及的文件列表**：
- 新建 `src/core/di/ServiceContainer.ts`
- 新建 `src/core/di/tokens.ts`
- 新建 `src/core/di/container-setup.ts`
- 所有核心类的构造函数（改为接受接口而非具体类）

**预期收益**：
- 核心模块可独立单元测试（通过注入 mock 实现）
- 依赖关系显式声明，代码可读性提升
- 环境切换灵活（生产/测试/开发可使用不同的容器配置）
- 无需引入第三方 DI 库，保持轻量

**注意事项/风险**：
- 手动 DI 容器缺少类型安全（resolve 返回 `any`），可通过 TypeScript 泛型和 Token 类型映射改善
- 不建议一次性全项目迁移，应从核心类开始逐步引入
- 避免过度抽象——仅对需要 mock 的关键依赖使用 DI，简单工具函数无需注入

---

#### G.2 核心模块接口化

**问题现状**：模块间通过直接导入具体实现类通信，几乎无接口定义。接口抽象评分仅 2.5/5，这使得模块替换、mock 测试、和未来架构演进都非常困难。

**具体改进方案**：为核心模块定义接口，逐步实现依赖反转：

```typescript
// 需要接口化的核心模块及其接口定义

// 1. ITaskExecutor
// src/core/task/interfaces/ITaskExecutor.ts
interface ITaskExecutor {
  executeTask(config: TaskConfig): Promise<TaskResult>;
  abortTask(taskId: string): Promise<void>;
  getTaskStatus(taskId: string): TaskStatus;
}

// 2. IMcpHub
// src/services/mcp/interfaces/IMcpHub.ts
interface IMcpHub {
  connect(config: McpServerConfig): Promise<void>;
  disconnect(serverId: string): Promise<void>;
  getConnectedServers(): McpServerInfo[];
  executeTool(serverId: string, toolName: string, params: any): Promise<any>;
}

// 3. IPromptEngine
// src/core/prompts/interfaces/IPromptEngine.ts
interface IPromptEngine {
  generateSystemPrompt(config: PromptGenerationConfig): string;
  getSectionVersions(): SectionVersion[];
}

// 4. IToolRegistry
// src/core/tools/interfaces/IToolRegistry.ts
interface IToolRegistry {
  getAvailableTools(mode: string): ToolDefinition[];
  executeTool(toolUse: ToolUse, context: ToolContext): Promise<ToolResult>;
}

// 5. IApiHandlerFactory
// src/api/interfaces/IApiHandlerFactory.ts
interface IApiHandlerFactory {
  createHandler(options: ApiHandlerOptions): ApiHandler;
  getAvailableProviders(): ProviderInfo[];
}

// 实施路径：
// 1. 先定义接口文件（不影响现有代码）
// 2. 让现有实现类 implements 接口（编译器自动检查兼容性）
// 3. 将消费方的导入从具体类改为接口
// 4. 在 DI 容器中注册接口到实现的映射
```

**涉及的文件列表**：
- 新建 `src/core/task/interfaces/ITaskExecutor.ts`
- 新建 `src/services/mcp/interfaces/IMcpHub.ts`
- 新建 `src/core/prompts/interfaces/IPromptEngine.ts`
- 新建 `src/core/tools/interfaces/IToolRegistry.ts`
- 新建 `src/api/interfaces/IApiHandlerFactory.ts`
- 各核心类（添加 `implements` 声明）
- 所有消费核心类的文件（导入接口替代实现）

**预期收益**：
- 接口抽象评分从 2.5/5 提升至 4/5
- 模块可替换性大幅提升
- 支持 mock 测试，单元测试覆盖率可显著提高
- 为微服务化或跨平台复用奠定接口基础

**注意事项/风险**：
- 接口设计需要稳定，频繁修改接口会导致大量连锁改动
- 建议先从消费者最多的接口开始（如 ITaskExecutor），收益最大
- 避免"接口膨胀"——不是每个类都需要接口，仅对跨模块边界的核心类定义接口

---

## 6. 设计模式应用建议

以下设计模式当前未充分利用，但高度适合引入：

| 设计模式 | 应用场景 | 当前问题 | 预期收益 |
|---------|---------|---------|---------|
| **注册表模式 (Registry)** | API Provider 工厂 | 25+ 分支 switch 语句，每次新增 Provider 需修改核心文件 | 新增 Provider 仅需注册，零侵入式修改 |
| **策略模式 (Strategy)** | MCP 传输层（stdio/SSE/HTTP）、错误重试策略、Token 计数策略 | 单方法内大型 if-else，各种策略硬编码 | 每种策略独立封装，可独立测试和替换 |
| **中介者模式 / 事件总线 (Mediator/Event Bus)** | ClineProvider 与各模块的通信 | 8+ 模块直接导入 ClineProvider 实现类 | 解耦模块间通信，消除循环依赖 |
| **外观模式 (Facade)** | Task 工具执行子系统 | Task 直接持有 4 个工具相关字段，操纵底层 API | Task 仅面对一个 `IToolExecutionOrchestrator` 接口 |
| **工厂方法模式 (Factory Method)** | MCP Transport 创建 | 单个方法中 190 行处理三种传输类型 | 每种传输类型有独立工厂，职责清晰 |
| **模板方法模式 (Template Method)** | API 格式转换 | 8+ 转换文件存在 1000+ 行重复代码 | 定义转换基类，子类仅实现差异部分 |
| **依赖注入 (DI)** | 核心类构造（Task、ClineProvider、McpHub） | 直接 `new` 依赖对象，无法替换为测试双 | 通过构造参数注入依赖，支持 mock 测试 |
| **上下文对象模式 (Context Object)** | 提示词生成入口 | `SYSTEM_PROMPT()` 有 13 个参数 | 封装为 `PromptGenerationConfig`，调用清晰、易扩展 |

---

## 7. 结论与下一步行动

### 7.1 总体评价

Njust-AI 是一个**功能强大但架构债务明显**的项目。其核心价值——广泛的 LLM 提供商支持、丰富的工具生态、灵活的模式系统——建立在快速迭代的基础上，但同时积累了显著的结构性问题。三大"上帝类"、循环依赖、缺失的接口抽象和不完善的错误处理是制约项目长期健康发展的主要瓶颈。

积极的一面是，项目已展现出模块化的趋势（`ToolExecutionOrchestrator`、`TaskLifecycle`、`TaskMetrics` 等），工具系统的架构设计也堪称优秀。这说明团队有意识地在改善架构，需要的是一个系统性的改进计划来加速这一进程。

### 7.2 按优先级排序的行动清单

以下行动按优先级从高到低排列，优先级基于**影响范围 × 风险等级 × 实施难度**综合评估。

#### 🔴 优先级 P0 — 必须执行（安全与稳定性）

| # | 行动项 | 对应改进建议 | 预期效果 |
|---|--------|------------|---------|
| 1 | **修复工具权限 bypass 安全漏洞** | E.2 安全审批机制加固 | 消除最严重的安全风险，阻止未授权的权限绕过 |
| 2 | **添加命令执行危险操作检查** | E.2 安全审批机制加固 | 防止通过工具执行 `rm -rf` 等破坏性命令 |
| 3 | **实现 API 重试与错误分类框架** | D.2 重试与错误分类框架 | 429/500 错误自动恢复，服务稳定性显著提升 |
| 4 | **修复 Task.dispose 重复重置缺陷** | A.1 Task.ts 拆分方案 | 消除已确认的代码缺陷，防止潜在的资源泄漏 |

#### 🟠 优先级 P1 — 强烈建议（架构瓶颈消除）

| # | 行动项 | 对应改进建议 | 预期效果 |
|---|--------|------------|---------|
| 5 | **消除 webview ↔ task 循环依赖** | B.1 事件总线 + ITaskUINotifier 接口 | 打破系统最严重的循环依赖，Task 模块可独立测试 |
| 6 | **消除 mcp ↔ webview 循环依赖** | B.2 IMcpStatusSink 接口 | 服务层不再依赖 UI 层，符合分层架构原则 |
| 7 | **实现 API 提供商注册表** | D.1 ProviderRegistry 替代 switch | 新增提供商改动从 7+ 处降至 1 处，符合开闭原则 |
| 8 | **Task.ts 核心拆分** | A.1 TaskExecutor/TaskLifecycleManager/ToolExecutionContext | 5181 行降至 ~500 行，可独立测试 |
| 9 | **ClineProvider.ts 核心拆分** | A.2 TaskCenter/ModeConfigService/WebviewHost | 3376 行降至 ~300 行，解除 8+ 模块的直接依赖 |
| 10 | **分离提示词中的业务逻辑** | F.1 CangjieErrorAnalyzer/RuleFileManager 等 | cangjie-context 从 3134 行降至 ~300 行 |

#### 🟡 优先级 P2 — 建议执行（代码质量与开发效率）

| # | 行动项 | 对应改进建议 | 预期效果 |
|---|--------|------------|---------|
| 11 | **修复 shared → core 反向依赖** | C.1 常量下移到 shared 层 | shared 层恢复独立性 |
| 12 | **修复 api → core 反向依赖** | C.2 IToolCallParser 接口 | API 层可独立于 core 测试和打包 |
| 13 | **McpHub.ts 拆分** | A.3 McpConfigLoader/TransportFactory/McpConnectionManager | 2052 行降至 ~300 行，传输策略可独立测试 |
| 14 | **统一工具参数验证** | E.1 Schema 驱动验证框架 | 消除 3 种验证模式不一致问题 |
| 15 | **SYSTEM_PROMPT 参数列表重构** | F.2 PromptGenerationConfig 对象 | 13 个参数简化为 1 个配置对象 |
| 16 | **编辑工具整合** | E.3 保留 search_replace，废弃冗余工具 | LLM 工具选择准确率提升，维护成本降低 |
| 17 | **Token 计数准确性改进** | D.3 native token counting | 精度从 ±15% 提升到 ±2% |

#### 🟢 优先级 P3 — 持续改进（长期架构健康）

| # | 行动项 | 对应改进建议 | 预期效果 |
|---|--------|------------|---------|
| 18 | **引入轻量级 DI 容器** | G.1 ServiceContainer | 核心模块可 mock 测试，环境切换灵活 |
| 19 | **核心模块接口化** | G.2 ITaskExecutor/IMcpHub/IPromptEngine 等 | 接口抽象评分从 2.5/5 提升至 4/5 |
| 20 | **提示词版本管理** | F.3 PromptVersionRegistry | 支持变更追踪、缓存破裂检测、A/B 测试 |
| 21 | **修复 utils → core 反向依赖** | C.3 类型下移或函数迁移 | 依赖关系图更清晰 |

### 7.3 执行建议

1. **每个行动项独立可交付**——上述行动按优先级排列但不强制顺序依赖，团队可根据资源情况灵活选取。少数有依赖关系的项目（如 #8 Task 拆分建议在 #5 循环依赖消除之后或同时进行）已在对应的改进建议章节中说明。

2. **每次改动确保测试通过**——每个行动项完成后应确保现有测试全部通过，避免大规模重写引入回归。

3. **关注度量指标**——建议跟踪以下指标来衡量改进效果：
   - 核心文件行数（目标：最大文件 < 500 行）
   - 循环依赖数量（目标：0）
   - 耦合度评分（目标：从 7/10 降至 3/10）
   - 单元测试覆盖率（目标：核心模块 > 80%）
   - 综合架构评分（目标：从 2.8/5 提升至 4.0/5）

---

*本报告基于 5 份专项审查报告综合分析生成，涵盖了 Njust-AI 项目 `src/` 和 `packages/` 的核心架构维度。*
