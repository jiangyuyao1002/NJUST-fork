# Runbook 006: Bundle Size / 激活性能回归排查

## 症状

- CI 流水线 `check-bundle-size` 任务失败，输出 "extension.js 超过阈值"
- CI 流水线 `report-activation-perf` 任务报告 P95 超过 500ms
- 用户反馈扩展启动变慢或 VS Code 整体响应迟钝
- `dist/extension.js` 文件大小突然增长超过 2 MB

## 关键指标与阈值

| 指标         | 红线   | 黄色预警 | 基线（2026-06） |
| ------------ | ------ | -------- | --------------- |
| extension.js | 30 MB  | 20 MB    | 13.21 MB        |
| 激活 P95     | 500ms  | 400ms    | 待字段数据      |
| 激活 P99     | 1500ms | 1000ms   | 待字段数据      |
| dist 总计    | 120 MB | 100 MB   | 94.65 MB        |

## 诊断步骤

### 1. 定位 bundle 增长来源

运行构建并检查 metafile 分析：

```bash
cd src && node esbuild.mjs --production
node ../scripts/check-bundle-size.mjs
```

如果 extension.js 超限，用 esbuild 的分析功能对比两次构建的 metafile：

```bash
# 保存当前 metafile
cp src/dist/metafile.json /tmp/metafile-current.json

# 与上一次 CI 通过的 metafile 对比
# CI artifact 中保存了每次构建的 metafile.json
diff <(node -e "const m=require('/tmp/metafile-baseline.json');Object.entries(m.inputs).sort((a,b)=>b[1].bytes-a[1].bytes).slice(0,20).forEach(([k,v])=>console.log(v.bytes,k))") \
     <(node -e "const m=require('/tmp/metafile-current.json');Object.entries(m.inputs).sort((a,b)=>b[1].bytes-a[1].bytes).slice(0,20).forEach(([k,v])=>console.log(v.bytes,k))")
```

### 2. 常见增长原因

**新依赖引入：** 检查 `pnpm-lock.yaml` 的 diff，搜索新增的 npm 包。重点关注：

- 整包引入而非按需引入（如 `import _ from "lodash"` 而非 `import debounce from "lodash/debounce"`）
- 包含大型静态资源（JSON 数据文件、wasm 文件）的依赖
- 引入的包自身依赖了大量传递依赖

**动态 require 退化：** esbuild 遇到模板字面量 `require(\`.../${variable}/...\`)` 时会 glob 匹配所有可能路径。检查是否新增了类似的动态 require 模式。

**pdf-parse 去重插件失效：** 如果 `src/esbuild.mjs` 中的 `deduplicate-pdf-parse` onLoad 插件的正则不再匹配（pdf-parse 升级导致路径变化），4 个 pdf.js 版本会重新被打包，增加约 3 MB。

验证方法：

```bash
node -e "const m=require('./src/dist/metafile.json');const pdf=Object.keys(m.inputs).filter(k=>k.includes('pdf-parse')&&k.includes('pdf.js/v'));console.log('pdf-parse versions:',new Set(pdf.map(k=>k.match(/pdf\\.js\\/(v[\\d.]+)\\//)?.[1]).filter(Boolean)));console.log('file count:',pdf.length)"
```

期望输出：`pdf-parse versions: Set(1) { 'v1.10.100' }`，`file count: 2`。

### 3. 激活性能回归排查

如果激活 P95 超过阈值：

1. 在 VS Code 中运行 "Developer: Startup Performance" 命令，查看扩展激活耗时分解
2. 检查 `extension.ts` 的 `activate()` 函数是否有新增的同步操作（`await`、同步文件读取、大型模块初始化）
3. 确认 CangjieLspClient、CodeIndexManager 等非核心组件使用 fire-and-forget 模式（`void xxx.start()`）而非阻塞等待

```bash
# 检查 activate() 中的 await 数量
grep -c "await " src/extension.ts
```

如果 await 数量增长，审查新增的 await 是否可以在 activate 返回后异步执行。

### 4. 修复与验证

修复后重新构建并验证：

```bash
cd src && node esbuild.mjs --production
cd .. && node scripts/check-bundle-size.mjs
```

确认 extension.js 在 30 MB 红线内。对于激活性能，需要在本地安装扩展后通过遥测数据验证：

```bash
# 安装后运行遥测报告
node scripts/report-activation-perf.mjs --days=7
```

## 升级路径

如果优化空间用尽（extension.js 接近 30 MB），参考 ADR-006 的 P1/P2 策略：

- P1: 将大型 Provider SDK 改为 `await import()` 动态加载
- P2: 将 tiktoken 编码器数据外置到 dist/ 目录（当前占 16.8%）

## 相关文档

- [ADR-006: 性能预算与 Bundle Size 红线](../adr/006-performance-budget.md)
- [覆盖率基线](../baseline/coverage-2026-07.md)
- `scripts/check-bundle-size.mjs` — CI bundle 检查脚本
- `scripts/report-activation-perf.mjs` — 激活性能报告脚本
- `src/esbuild.mjs` — esbuild 构建配置（含 pdf-parse 去重插件）
