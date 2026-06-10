## NJUST-AI (Roo-Code) 工业级代码改进计划

**制定日期**：2026年6月9日
**团队规模**：1-2 人
**Sprint 周期**：2 周 / Sprint
**总周期**：6 个 Sprint（12 周）

---

### Sprint 1：安全与稳定性基线（第 1-2 周）

本 Sprint 聚焦于修复 3 个 High 级别的安全和稳定性问题。这些是必须在第一个迭代中解决的阻塞性问题。

**任务 1.1 — 修复 RooIgnoreController fail-open 漏洞**

- 文件：`src/core/ignore/RooIgnoreController.ts` 第 132-134 行
- 当前代码：外层 catch 块在异常时返回 `true`（允许访问）
- 修复方案：将 `return true` 改为 `return false`（fail-closed），与 `RooProtectedController`（第 68-73 行）保持一致
- 同时修复第 121-124 行 realpathSync 失败时的回退逻辑，改为也返回 false
- 编写对应测试：构造让 realpathSync 抛异常的路径，断言 validateAccess 返回 false
- 验收标准：现有测试全部通过 + 新增 2 个 fail-closed 测试用例

**任务 1.2 — 修复 deactivate() 资源泄漏**

- 文件：`src/extension.ts` 第 352-375 行
- 需补充清理的资源（按优先级排序）：
    1. 移除 `process.on("unhandledRejection"/"uncaughtException")` 监听器 — 将监听器引用保存为模块级变量，在 deactivate 中调用 `process.removeListener()`
    2. 调用 `ContextProxy` 的 dispose 方法（如果存在）或清理其 secretRefreshInterval
    3. 调用 `TokenBucketRateLimiter.resetInstance()` 清理 refillTimer
    4. 显式 dispose `ClineProvider`（确保 webview 和 API handler 被释放）
    5. dispose `outputChannel`
- 验收标准：deactivate 后无遗留的 setInterval/setTimeout，无遗留的 process 监听器

**任务 1.3 — 修复 TokenBucketRateLimiter 共享 timer bug**

- 文件：`src/services/rate-limiter/TokenBucketRateLimiter.ts` 第 41 行、第 130 行
- 当前问题：所有 provider 共用一个 `refillTimer` 字段，后调度的 provider 会 clearTimeout 前一个 provider 的 timer
- 修复方案：将 `refillTimer` 改为 `Map<string, ReturnType<typeof setTimeout>>`，每个 provider 独立管理 timer
- 修改 `scheduleRefill(provider)` 方法：使用 `this.refillTimers.get(provider)` 替代全局 timer
- 修改 `reset()` 方法：遍历 Map 清理所有 timer
- 编写测试：两个 provider 同时等待限流，验证两者都能正确 resolve
- 验收标准：并发限流测试通过 + reset 后无遗留 timer

**任务 1.4 — 增强 bypass 模式下 dangerous 命令的审计**

- 文件：`src/core/tools/ExecuteCommandTool.ts` 第 125-128 行
- 修复方案：即使在 bypass 模式下，对 dangerous 级别命令也记录审计日志（通过 AuditLogger）
- 不改变执行逻辑，仅增加审计记录
- 验收标准：bypass 模式执行 dangerous 命令后审计日志中有记录

---

### Sprint 2：架构治理 — 分层修复（第 3-4 周）

本 Sprint 聚焦于修复 api/ → core/ 的反向依赖，这是当前最大的架构债务。

**任务 2.1 — 下沉 ModelFallback 到 packages/core/**

- 将 `src/core/task/ModelFallback.ts` 迁移到 `packages/core/src/task/ModelFallback.ts`
- 更新 `src/api/index.ts` 第 4 行的 import 路径
- 更新 `src/core/task/` 下所有引用 ModelFallback 的文件的 import 路径
- 在 `packages/core/src/index.ts` 中导出
- 验收标准：TypeScript 编译通过，现有测试全部通过

**任务 2.2 — 下沉 ToolCallParserImpl 到 packages/core/**

- 将 `src/core/assistant-message/ToolCallParserImpl.ts` 迁移到 `packages/core/src/assistant-message/`
- 更新 `src/api/index.ts` 第 5 行的 import 路径
- 验证 `packages/core` 的 `index.ts` 导出
- 验收标准：TypeScript 编译通过，现有测试全部通过

**任务 2.3 — 下沉 taskEventBus 接口到 packages/core/**

- 在 `packages/core/src/events/` 中定义 `ITaskEventBus` 接口（仅接口，不含实现）
- 修改 `src/api/providers/base-provider.ts` 第 13 行：依赖接口而非 `core/events/TaskEventBus` 实现
- 修改 `src/api/retry/ApiRetryWrapper.ts` 第 7 行：同上
- 验收标准：api/ 层不再直接 import core/events/

**任务 2.4 — 迁移 native-tools/converters 到 api/transform/**

- 将 `src/core/prompts/tools/native-tools/converters.ts` 迁移到 `src/api/transform/native-tool-converters.ts`
- 更新 `src/api/providers/anthropic.ts` 第 18 行、`anthropic-vertex.ts` 第 24 行、`minimax.ts` 第 17 行的 import
- 在 core 层保留一个 re-export 文件以保持向后兼容
- 验收标准：api/ 层不再 import core/prompts/

**任务 2.5 — 提取 ContextProxy 的模型缓存为独立接口**

- 定义 `IModelCacheStore` 接口（get/set 模型信息的方法）
- 修改 `src/api/providers/fetchers/modelCache.ts` 第 14 行和 `modelEndpointCache.ts` 第 10 行：依赖接口
- ContextProxy 实现该接口
- 验收标准：api/providers/fetchers/ 不再直接 import core/config/ContextProxy

**任务 2.6 — 运行 check-circular 验证无新循环依赖**

- 执行 `pnpm check:circular`
- 确保所有迁移未引入新的循环依赖
- 验收标准：CI 循环依赖检查通过

---

### Sprint 3：代码质量治理 — 空 catch 与超大文件（第 5-6 周）

**任务 3.1 — 治理重灾区空 catch 块（第一批：Top 5 文件，约 48 处）**

按文件逐个处理，每个空 catch 块添加 `logger.debug()` 或注释说明为何忽略：

- `cjpmProjectParser.ts` — 13 处，仓颉项目解析的非关键路径，添加 `logger.debug("cjpm parse failed: ...")`
- `TaskHistoryStore.ts` — 11 处，历史记录存储的容错读取，添加 `logger.warn("history store read failed: ...")`
- `CustomModesManager.ts` — 9 处，配置迁移的向后兼容尝试，添加注释说明
- `RuleFileManager.ts` — 7 处，规则文件读取的容错，添加 `logger.debug()`
- `NativeToolCallParser.ts` — 7 处，XML 解析的试探性匹配，添加注释说明

处理原则：如果 catch 是有意忽略（如"尝试 A，失败则回退 B"），添加 `// intentionally ignored: <原因>` 注释；如果是应当记录但未记录的错误，添加 logger 调用。

验收标准：Top 5 文件的空 catch 块降为 0，现有测试全部通过

**任务 3.2 — 治理空 catch 块（第二批：剩余约 283 处）**

- 编写脚本自动分类空 catch 块：有 `// intentional` 注释的跳过，其余标记待处理
- 按目录分批处理：services/(30)、api/(18)、integrations/(18)、utils/(20)、core/webview/(7)
- 验收标准：全仓库空 catch 块数量降至 50 以下（允许少量有意忽略的 catch）

**任务 3.3 — 拆分 bedrock.ts（1601 行）**

- 文件：`src/api/providers/bedrock.ts`
- 拆分为：
    - `bedrock-base.ts` — 基础配置和模型定义（约 300 行）
    - `bedrock-client.ts` — AWS SDK 客户端封装（约 400 行）
    - `bedrock.ts` — Provider 实现，组装 base + client（约 500 行）
    - `bedrock-converse.ts` — Converse API 流处理（约 400 行）
- 验收标准：bedrock.ts 降至 600 行以下，现有测试全部通过

**任务 3.4 — 添加 Vitest retry 配置**

- 文件：`src/vitest.config.ts`
- 添加 `retry: 2` 配置（每个测试最多重试 2 次）
- 验收标准：`pnpm test` 正常运行

---

### Sprint 4：代码质量治理 — 超大文件续（第 7-8 周）

**任务 4.1 — 继续拆分 Task.ts（1604 行 → 目标 600 行）**

- 文件：`src/core/task/Task.ts`
- 提取内容：
    - MemRL 相关属性（memrlEpisodicHints, memrlLtmRules, memrlIntent 等）→ `MemoryContext.ts`
    - 工具定义缓存 → `TaskToolCache.ts`
    - 模式初始化逻辑 → `TaskModeInitializer.ts`
- 每个提取文件不超过 200 行
- 验收标准：Task.ts 降至 800 行以下，现有测试全部通过

**任务 4.2 — 拆分 NativeToolCallParser.ts（1294 行）**

- 拆分为：
    - `NativeToolCallParser.ts` — 解析核心逻辑（约 600 行）
    - `NativeToolCallFormatter.ts` — 格式化和序列化工具（约 400 行）
    - `NativeToolCallTypes.ts` — 类型定义（约 100 行）
- 验收标准：单文件不超过 700 行

**任务 4.3 — 拆分 presentAssistantMessage.ts（1200 行）**

- 按消息类型拆分为多个 Presenter：
    - `TextPresenter.ts` — 文本消息呈现
    - `ToolResultPresenter.ts` — 工具结果呈现
    - `ErrorPresenter.ts` — 错误消息呈现
    - `DiffPresenter.ts` — Diff 视图呈现
- 验收标准：单文件不超过 400 行

**任务 4.4 — 清理冗余编辑工具文件**

- 删除 `src/core/tools/SearchAndReplaceTool.ts`（173B，仅为 EditTool 的废弃重导出）
- 检查 `EditFileTool.ts`（22.4KB）和 `SearchReplaceTool.ts`（10.1KB）是否仍有外部引用
- 如果有引用但功能已被 EditTool 覆盖，更新引用指向 EditTool 并删除冗余文件
- 验收标准：编辑相关工具文件数量减少，registerAllTools.ts 注册数不变

**任务 4.5 — 补全 coverage.include 配置**

- 文件：`src/vitest.config.ts` 第 30 行
- 在 include 中添加：`src/utils/**`、`src/integrations/**`、`src/activate/**`、`src/shared/**`、`src/i18n/**`
- 验收标准：覆盖率报告包含所有源码目录

---

### Sprint 5：测试覆盖与性能优化（第 9-10 周）

**任务 5.1 — 补充 inline-completion 模块测试**

- 目标文件：`src/services/inline-completion/` 目录
- 为 InlineCompletionProvider 编写单元测试：
    - 正常补全流程
    - 上下文不足时的降级行为
    - 超时和错误处理
- 目标覆盖率：> 60%

**任务 5.2 — 补充 agent 模块测试**

- 目标文件：`src/core/agent/` 目录
- 为 AgentOrchestrator 编写测试：
    - 单 Agent 执行
    - 多 Agent 并行执行
    - 循环依赖检测
    - Agent 失败处理
- 为 PlanEngine 编写测试：计划生成的 JSON 解析和验证
- 目标覆盖率：> 60%

**任务 5.3 — 补充 stream 和 context-tracking 模块测试**

- `src/core/stream/` — 流控制的基本测试
- `src/core/context-tracking/` — 上下文追踪的测试
- 目标覆盖率：> 50%

**任务 5.4 — 引入统一错误分类体系**

- 创建 `src/core/errors/ErrorCategory.ts`：
    - `ApiError` — API 调用错误（超时、限流、认证）
    - `ToolError` — 工具执行错误（权限、文件不存在、超时）
    - `ConfigError` — 配置错误（无效设置、缺失配置）
    - `InternalError` — 内部错误（未预期的异常）
- 在 Sprint 3/4 已处理的 catch 块中使用新的错误分类
- 验收标准：核心模块使用统一的错误类型

**任务 5.5 — 优化扩展激活并行化**

- 文件：`src/extension.ts` activate 函数
- 分析当前 27 个初始化步骤的依赖关系，找出可进一步并行的步骤
- 将目前串行的步骤尽可能加入 Promise.allSettled 并行组
- 添加激活性能基准：记录每个步骤的耗时
- 验收标准：激活时间不增加，性能数据可观测

---

### Sprint 6：国际化与长期演进（第 11-12 周）

**任务 6.1 — 清理硬编码中文字符串**

- 搜索所有 .ts 文件中的中文字符串（排除注释和测试文件）
- 将 UI 可见的中文字符串替换为 i18n key 引用
- 注释中的中文可以保留（不影响国际化）
- 验收标准：生产代码中无硬编码中文 UI 文本

**任务 6.2 — 扩展 validateCommand() 命令覆盖**

- 文件：`src/core/ignore/RooIgnoreController.ts` 第 143-189 行
- 添加以下命令的文件路径检查：
    - `python` / `python3` — `-c` 参数中的文件路径
    - `node` — `-e` 参数和直接执行的脚本路径
    - `dd` — `if=` 参数
    - `php` / `ruby` / `perl` — 脚本执行
- 或改用更通用的策略：从命令参数中提取所有看起来像文件路径的参数，统一检查
- 验收标准：上述命令的文件路径访问受 .rooignore 约束

**任务 6.3 — 编写改进成果验证报告**

- 重新运行全量测试：`pnpm test`
- 运行循环依赖检查：`pnpm check:circular`
- 运行死代码检查：`pnpm knip`
- 运行类型检查：`pnpm check-types`
- 运行 lint：`pnpm lint`
- 检查覆盖率门槛是否达标
- 生成改进前后的对比数据
- 验收标准：所有质量门禁通过

**任务 6.4 — 制定后续演进路线（P3 级）**

为后续 Sprint 制定长期目标（不在本周期执行）：

1. 将更多平台无关逻辑迁移到 packages/core/（context-management、condense、prompts 纯逻辑）
2. 收敛三套 OpenAI 兼容实现为一套
3. 将 src/ 和 webview-ui/ 迁移到 apps/ 下
4. 考虑引入轻量 DI 容器
5. 为提示词系统引入版本管理

---

### 里程碑总览

| Sprint |   周期    | 主题         | 核心交付物                    | 验收标准                         |
| :----: | :-------: | ------------ | ----------------------------- | -------------------------------- |
| **S1** |  第1-2周  | 安全与稳定性 | 3个High修复 + bypass审计      | 安全漏洞清零，deactivate无泄漏   |
| **S2** |  第3-4周  | 架构分层修复 | api→core 6处反向依赖清零      | check-circular通过，分层约束恢复 |
| **S3** |  第5-6周  | 代码质量(上) | Top5空catch治理 + bedrock拆分 | 空catch降至50以下                |
| **S4** |  第7-8周  | 代码质量(下) | 3个超大文件拆分 + 冗余清理    | 最大文件<800行                   |
| **S5** | 第9-10周  | 测试与性能   | 4模块测试补充 + 错误分类      | 覆盖率门槛达标                   |
| **S6** | 第11-12周 | 国际化与收尾 | 中文清理 + 命令覆盖扩展       | 全部门禁通过                     |

---

### 风险与缓解

**风险 1：测试回归**
每个任务修改后必须运行 `pnpm test` 全量测试。如果测试失败，优先修复测试而非跳过。

**风险 2：1 人团队进度压力**
如果只有 1 人，可将 Sprint 3/4 合并为一个 3 周 Sprint，优先处理空 catch 和最大的 2 个文件。Sprint 5/6 可延后。

**风险 3：重构引入新 bug**
每次文件迁移或拆分后，执行 `pnpm check-types && pnpm test && pnpm check:circular` 三重验证。

**风险 4：空 catch 块误改行为**
处理空 catch 块时，只添加日志或注释，不改变控制流。如果发现 catch 块确实隐藏了需要处理的错误，单独创建 issue 跟踪。

---

### 每 Sprint 验收清单

每个 Sprint 结束时检查：

- [ ] `pnpm test` 全部通过
- [ ] `pnpm check-types` 无类型错误
- [ ] `pnpm lint` 无 lint 错误
- [ ] `pnpm check:circular` 无新循环依赖
- [ ] `pnpm knip` 无新增死代码
- [ ] Sprint 任务中的验收标准逐条确认
- [ ] 代码变更已 commit 并 push
