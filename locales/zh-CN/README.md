# NJUST_AI

> 基于 [NJUST_AI](https://github.com/NJUST-AI/NJUST_AI) 定制的 **仓颉语言 AI 开发助手** VS Code 扩展，面向 NJUST 内部使用。

> **Attribution**: 本项目基于 [Roo Code](https://github.com/RooVetGit/Roo-Code)（Apache-2.0 许可证）进行二次开发，由 NJUST_AI 团队维护与扩展。

---

## 项目概述

NJUST_AI 是一个运行在 VS Code / Cursor 中的 AI 编程助手扩展。它在活动栏提供 Webview 侧栏界面，通过消息管道与 Extension Host 进程通信，实现多轮 AI 对话、工作区文件读写、终端命令执行、语义代码检索等功能。

扩展内建**仓颉（Cangjie）编程语言**的全栈工具链——包括 LSP 客户端、`cjpm` 任务集成、调试器适配、格式化与静态检查、测试 CodeLens 等，并支持 **Cloud Agent** 远程推理协议与 **MCP**（Model Context Protocol）工具生态。

本项目基于上游定制：**移除了**与账号、组织、市集浏览相关的上游云服务与 Marketplace 流程；**保留并扩展**了本地/自建服务对接能力。

---

## 核心能力

- **多模式 AI 协作**：7 个内置模式覆盖编码、规划、问答、调试、仓颉开发等场景
- **仓颉语言全栈支持**：语法高亮、LSP、cjpm 构建、cjfmt/cjlint、测试 CodeLens、cjdb 调试、经验修复系统
- **Cloud Agent 远程推理**：通过可配置的 REST 服务端执行代理任务，支持延期协议循环与编译反馈闭环
- **MCP 工具生态**：管理多服务器（stdio / SSE / Streamable HTTP），内置 HTTP MCP Tools Server
- **语义代码索引**：Tree-sitter 35+ 语言 AST 分块 + 嵌入向量化 + Qdrant 向量存储
- **MemRL 记忆系统**：四层跨任务记忆架构，让 Agent 累积仓颉编程经验
- **Skills 系统**：从工作区与全局目录发现 SKILL.md，支持模式路由与按需加载
- **检查点与回滚**：影子副本快照，支持 diff 对比与一键回滚
- **40+ 模型提供商**：Anthropic、OpenAI、Gemini、DeepSeek、Ollama、Qwen 等

---

## 内置模式

| 模式 | 说明 |
|------|------|
| **Cloud Agent** | 远程推理 + 本地工具执行，通过 CloudAgentOrchestrator 驱动 |
| **Architect** | 技术规划与任务拆解，含 Spec-Driven Workflow |
| **Code** | 编码实现，含算法/数据结构专项指导 |
| **Ask** | 技术问答与代码分析，只读 + MCP 工具集 |
| **Debug** | 系统化诊断：提出可能原因 → 缩小范围 → 验证 → 修复 |
| **Cangjie Dev** | 仓颉全栈开发，含 cjpm/cjc 工作流与语料检索 |
| **Orchestrator** | 复杂任务拆解为子任务，跨模式协调执行 |

支持通过 `njust-ai.customModes` 设置或项目根目录 `.roomodes` 文件自定义模式。

---

## 仓颉语言工具链

扩展为仓颉（Cangjie）编程语言提供完整的 IDE 级支持：

- **语法与片段**：TextMate 语法高亮 + 常用代码模板
- **cjpm 任务**：集成 build / run / test / bench / clean 等子命令到 VS Code Tasks
- **cjc 问题匹配**：解析编译器输出，映射到 Problems 面板
- **LSP 客户端**：补全（含自动导入）、跳转定义、查找引用、重命名、悬停、文档符号、代码折叠
- **格式化与静态检查**：`cjfmt` 保存时自动格式化，`cjlint` 保存时自动检查
- **测试 CodeLens**：在 `@Test` / `@TestCase` 函数上提供 Run / Debug 按钮
- **调试适配**：对接 `cjdb`，支持 hotReload 选项
- **经验修复（Learned Fixes）**：跨会话复用编译错误修复经验
- **Cangjie Dev 模式**：约束 Agent 工具范围与提示词，联动 Skills 中的仓颉语料

---

## 与上游的主要差异

| 模块 | 状态 | 说明 |
|------|------|------|
| 上游账号/组织/市集云 | 已移除 | 登录、组织管理、市集安装等外部闭环 |
| Marketplace | 已移除 | 远程市集浏览与安装；MCP 改由界面本地管理 |
| Telemetry | 已简化 | 保留类型结构，弱化远程上报逻辑 |
| Cloud Agent | 保留并增强 | 连接自建/内网服务，支持延期协议与 compile 反馈闭环 |
| 仓颉语言工具链 | 定制增强 | 语法/LSP/cjpm/cjfmt/cjlint/测试/调试/经验修复 |
| MCP 子系统 | 保留并增强 | 三种传输协议 + 内置 HTTP Tools Server |
| Modes 系统 | 保留并扩展 | 7 个内置模式，支持自定义覆盖 |
| 代码索引 | 保留并增强 | 多工作区单例，tree-sitter + Qdrant 向量存储 |
| MemRL 记忆系统 | 全新增加 | 四层跨任务记忆，向量检索 + Q 值更新 |

---

## 本地开发

### 环境要求

- Node.js 20.19.2+
- pnpm 10.8.1+

### 安装与运行

1. 克隆仓库：

```sh
git clone <repo-url>
cd NJUST_AI
```

2. 安装依赖：

```sh
pnpm install
```

3. 启动开发模式：

在 VS Code 中按 `F5` 启动调试，会打开一个加载了 NJUST_AI 扩展的新窗口。Webview 和核心扩展的修改都会自动热重载。

### 构建 VSIX

```sh
pnpm vsix
```

生成的 `.vsix` 文件位于 `bin/` 目录下，可通过以下命令安装：

```sh
code --install-extension bin/njust-ai-<version>.vsix
```

或使用自动化安装脚本：

```sh
pnpm install:vsix
```

---

## 许可证

[Apache 2.0](../../LICENSE)
