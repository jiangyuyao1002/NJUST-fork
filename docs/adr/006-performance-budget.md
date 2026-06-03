# ADR-006: 性能预算与 Bundle Size 红线

## Status

Accepted

## Context

OKR KR2.1（扩展激活 P95 ≤ 500ms）和 KR2.2（bundle size ≤ 30MB）需要明确的性能预算文档，作为 CI 红线和后续优化的基准。

### 基线数据（2026-06-03 测量）

**Bundle Size（优化后）：**

| 组件              | 大小         | 占比        |
| ----------------- | ------------ | ----------- |
| extension.js      | 13.21 MB     | 主产物      |
| wasm 文件（38个） | 61.50 MB     | 附属资源    |
| workers           | 3.53 MB      | Worker 脚本 |
| i18n              | 0.07 MB      | 国际化      |
| **dist 总计**     | **94.65 MB** | —           |

**优化前对比：**

| 阶段                            | extension.js | 说明                           |
| ------------------------------- | ------------ | ------------------------------ |
| 优化前（dev build）             | 33.75 MB     | 含 4 个 pdf.js 版本，无 minify |
| 优化前（production build）      | 16.12 MB     | minify 但未去重                |
| **优化后（production + 去重）** | **13.21 MB** | minify + pdf-parse 去重        |
| OKR 目标                        | ≤ 30 MB      | KR2.2                          |

**extension.js 组成分析（metafile.json，优化后）：**

| 维度         | 大小         | 占比 |
| ------------ | ------------ | ---- |
| node_modules | ~11.5 MB     | ~87% |
| 源码（src/） | ~1.5 MB      | ~11% |
| 其他         | ~0.2 MB      | ~2%  |
| **总计**     | **13.21 MB** | 100% |

**Top 5 包贡献（优化后）：**

| 包            | 大小    | 占比  | 说明                       |
| ------------- | ------- | ----- | -------------------------- |
| tiktoken      | 2.2 MB  | 16.8% | o200k_base 编码器数据      |
| pdf-parse     | 1.0 MB  | 7.7%  | 仅保留 v1.10.100（已去重） |
| @lmstudio/sdk | 0.27 MB | 2.0%  | LM Studio SDK              |
| tr46          | 0.25 MB | 1.9%  | Unicode 映射表             |
| @google/genai | 0.21 MB | 1.5%  | Google Gemini SDK          |

**激活性能：**

当前无字段数据（遥测已写入代码但扩展尚未重新构建安装）。测量基础设施已就绪：`scripts/report-activation-perf.mjs` 可解析 NDJSON 遥测日志并计算 P50/P95/P99。

### 与目标的差距

| 指标         | 优化前   | 优化后       | 目标    | 状态    |
| ------------ | -------- | ------------ | ------- | ------- |
| extension.js | 33.75 MB | **13.21 MB** | ≤ 30 MB | ✅ 达标 |
| 激活 P95     | 无数据   | 无数据       | ≤ 500ms | 待测量  |

## Decision

### 性能预算

| 预算项            | 红线值 | 黄色预警 | 说明           |
| ----------------- | ------ | -------- | -------------- |
| extension.js 大小 | 30 MB  | 20 MB    | CI 硬性拦截    |
| 激活 P95          | 500ms  | 400ms    | 需字段数据验证 |
| 激活 P99          | 1500ms | 1000ms   | 极端场景上限   |
| dist 总大小       | 120 MB | 100 MB   | 含 wasm 资源   |

### 已实施：pdf-parse 去重（P0）

通过 esbuild `onLoad` 插件拦截 `pdf-parse.js` 源文件，将动态 `require(\`./pdf.js/${options.version}/build/pdf.js\`)`替换为静态`require("./pdf.js/v1.10.100/build/pdf.js")`。esbuild 不再 glob 匹配所有 4 个版本，只打包实际使用的 v1.10.100。

**实测效果**：pdf-parse 从 8.06 MB（4 版本 × 2 文件 = 8 条目）降至 1.0 MB（1 版本 × 2 文件 = 2 条目），extension.js 从 16.12 MB 降至 13.21 MB（-2.91 MB）。

### 未来可选优化

**P1 — 大型 SDK 动态化（预估 -1~2 MB）：**

将非核心路径上的 Provider SDK 改为 `await import()` 动态加载。当前这些 SDK 在 production build + minify 后占比已不大。

**P2 — tiktoken 数据外置（预估 -2.2 MB）：**

将 tiktoken 的 o200k_base 编码器数据从 bundle 中移出。当前占 16.8%，是最大单项。但外置需要额外的文件分发机制。

### CI 红线配置

`scripts/check-bundle-size.mjs` 中 `EXTENSION_JS_LIMIT_MB` 设为 **30**（对齐 OKR KR2.2），CI workflow 在 PR 合并前硬性拦截。

## Consequences

**正向：**

- extension.js 从 33.75 MB 降至 13.21 MB（-61%），远超 30 MB 目标
- pdf-parse 去重通过 esbuild onLoad 插件实现，零代码改动，仅修改构建配置
- 明确的性能预算为 CI 自动化提供了可执行的判定标准
- 黄色预警线（20 MB）为未来增长留出了 50% 的缓冲空间

**负向：**

- onLoad 插件拦截并修改 pdf-parse.js 源文件，如果 pdf-parse 升级可能需要同步更新插件中的正则表达式
- 动态加载 Provider SDK（P1）会增加首次使用时的延迟
- tiktoken 数据外置（P2）需要额外的 VSIX 文件分发机制

**风险：**

- pdf-parse 升级时 onLoad 过滤器 `pdf-parse[/\\]lib[/\\]pdf-parse\.js$` 可能不再匹配（如目录结构变化）
- 激活 P95 目标（500ms）需要字段数据验证，当前无法确认是否合理
