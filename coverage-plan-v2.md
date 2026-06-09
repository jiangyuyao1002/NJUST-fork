## 覆盖率提升 — 下一步执行计划（v2）

### 诊断结论

7 个未提交的测试文件共 92 个 it() 用例，但覆盖率仅提升 0.3-0.4%。根因：

- **CangjieCompileGuard** (24 tests)：核心编译流水线 `compileImpl`(130行) + `execBuild`(40行) 完全未测，现有测试只覆盖了辅助函数
- **CangjieLspStatusBar** (6 tests)：7个文件中质量最差，所有测试只验证构造函数副作用，`updateLspState` / `attachCompileGuard` 等状态逻辑零覆盖
- **CjfmtFormatter** (5 tests)：成功格式化路径和范围格式化未测
- **cangjieToolUtils** (13 tests)：下半部 AI 辅助函数（`getSymbolContextForFile` 等）未测
- **CangjieSymbolIndex** (25 tests)：质量最高，但 `reindexFile` / `fullIndex` 等文件索引核心未测
- **CangjieLintConfig** (11 tests)：`runCustomRules` 自定义规则引擎未测
- **CangjieMetricsCollector** (8 tests)：持久化、错误趋势、边界截断未测

### 两步走策略

#### 第一步：深化现有 7 个文件（预计 +600 行覆盖）

优先修复投入产出比最高的 3 个文件：

**A. CangjieCompileGuard — 补充 compileImpl 流水线测试（最高优先）**

- mock `child_process.execFile` 返回成功/失败结果
- 覆盖 `compileImpl` 全部分支：增量/全量构建决策、构建成功/失败、错误位置解析 (`CJC_ERROR_LOCATION_RE`)、metrics 记录
- 覆盖 `publishCompileDiagnostics` 诊断发布逻辑
- 覆盖 `truncateCompileDiagnosticMessage` 截断函数
- 覆盖 `registerSaveHook` + `runDebouncedPostSavePipeline` 防抖编译
- 预计新增 ~15 个 test case，覆盖 ~200 行

**B. CangjieLspStatusBar — 补充状态转换测试**

- 覆盖 `updateLspState` 6 种状态（idle/starting/running/warning/error/stopped）的 UI 更新
- 覆盖 `attachCompileGuard` 编译事件监听和状态栏文本更新
- 覆盖 `updateVisibility` 基于语言类型的显示/隐藏逻辑
- 预计新增 ~12 个 test case，覆盖 ~80 行

**C. cangjieToolUtils — 补充 AI 辅助函数测试**

- 覆盖 `getSymbolContextForFile` 符号上下文提取
- 覆盖 `getReferencesForSymbol` 引用查找
- 覆盖 `autoDetectPackageDeclaration` 包声明自动检测
- 覆盖 `formatCangjieToolchainSummaryLine` 格式化
- 预计新增 ~10 个 test case，覆盖 ~80 行

**D. CangjieLintConfig — 补充自定义规则引擎测试**

- 覆盖 `runCustomRules` 正则匹配逻辑、多规则执行、错误处理
- 覆盖 `loadConfig` JSON 解析失败 fallback
- 覆盖 `mapSeverity` 全部分支
- 预计新增 ~8 个 test case，覆盖 ~40 行

**E. CangjieMetricsCollector — 补充边界与持久化测试**

- 覆盖 `saveToDisk` / `loadOrCreate` 版本重建
- 覆盖 `updateErrorTrend` 按日聚合 + MAX_TREND_DAYS 截断
- 覆盖 `updateAvgErrors` 多次构建计算
- 覆盖 recentBuilds > 100 截断、topErrors > 20 截断
- 预计新增 ~8 个 test case，覆盖 ~40 行

**F. CjfmtFormatter — 补充成功路径测试**

- 覆盖 `formatDocument` 成功返回 TextEdit
- 覆盖 `provideDocumentRangeFormattingEdits`
- 预计新增 ~4 个 test case，覆盖 ~30 行

**G. CangjieSymbolIndex — 补充索引维护测试**

- 覆盖 `reindexFile` 文件索引/解析
- 覆盖 `removeFile` + 依赖查询
- 覆盖 `isCodeTokenPosition` / `_symbolNameUsedInSource` 顶层函数
- 预计新增 ~8 个 test case，覆盖 ~60 行

第一步小计：约 65 个新增 test case，约 530 行新增覆盖

---

#### 第二步：拓展新高 ROI 模块（预计 +800 行覆盖）

这些模块不在已有的 7 个文件中，是全新的测试目标：

**H. learnedFixMatching.ts（核心 prompts 模块 — 最高 ROI）**

- 当前覆盖率：18.15%（~490 行未覆盖，总 ~600 行）
- 特点：算法模块，大量纯函数，mock 依赖极少
- 测试策略：匹配算法正确性、边界输入、性能相关分支
- 预计新增 ~20 个 test case，覆盖 ~300 行

**I. CangjieSemanticTokensProvider.ts（cangjie-lsp 最薄弱 Provider）**

- 当前覆盖率：10.43%（~183 行未覆盖，总 ~202 行）
- 测试策略：Legend 注册、Token 提供（空/有内容文档）、Token 编码计算、LSP 响应解析
- 预计新增 ~12 个 test case，覆盖 ~140 行

**J. cangjieCommands.ts（cangjie-lsp 最大未覆盖量）**

- 当前覆盖率：8.56%（~460 行未覆盖，总 ~507 行）
- 测试策略：命令注册验证、各命令执行逻辑、错误处理
- 预计新增 ~25 个 test case，覆盖 ~200 行

**K. CangjieInliningProvider.ts（cangjie-lsp 低覆盖补充）**

- 当前覆盖率：8.33%（~235 行未覆盖，总 ~255 行）
- 测试策略：inlay hint 提供逻辑、LSP 响应转换
- 预计新增 ~10 个 test case，覆盖 ~100 行

第二步小计：约 67 个新增 test case，约 740 行新增覆盖

---

### 执行顺序与并行策略

```
批次 1（可并行）: A(CompileGuard) + B(StatusBar) + D(LintConfig) + E(Metrics)
批次 2（可并行）: C(ToolUtils) + F(Formatter) + G(SymbolIndex)
批次 3（可并行）: H(learnedFixMatching) + I(SemanticTokens) + J(Commands) + K(Inlining)
```

每批次完成后运行 `npx vitest run --config src/vitest.config.ts` 快速验证（不跑覆盖率，仅确认测试通过）。

全部完成后运行 `npx vitest run --coverage --config src/vitest.config.ts` 检查覆盖率。

### 预估覆盖率结果

| 指标       | 当前   | 第一步后 | 第二步后 | 阈值 |
| ---------- | ------ | -------- | -------- | ---- |
| Lines      | 67.58% | ~69.0%   | ~71.0%   | 69%  |
| Functions  | 69.30% | ~70.2%   | ~71.5%   | 70%  |
| Statements | 66.49% | ~68.1%   | ~70.0%   | 68%  |
| Branches   | 58.29% | ~59.8%   | ~61.5%   | 60%  |

两步合计：约 132 个新增 test case，约 1270 行新增覆盖。

### 关键编码注意事项

1. **ESLint 红线**：不用 `Function` 类型 → 用 `(...args: any[]) => void`；不留未使用导入
2. **Mock 子进程**：`compileImpl` 和 `execBuild` 需要 mock `child_process.execFile`，用 `vi.mock("child_process")` + `vi.fn()` 模拟成功/失败回调
3. **测试深度要求**：不要只验证"不抛异常"，必须验证返回值、mock 调用参数、状态变更等可观察行为
4. **CLAUDE.md 规则**：提交前必须中文总结并询问用户
