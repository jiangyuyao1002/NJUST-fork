# 仓颉语言开发工作流规则

## 1. 工具链速查

在执行构建操作前先确认：`cjpm --version && cjc --version`

| 工具 | 用途 | 关键命令 |
|------|------|----------|
| `cjpm` | 项目管理 | `cjpm build / run / test / clean / init / update / check / tree` |
| `cjc` | 编译器 | `cjc file.cj -o output` |
| `cjlint` | 静态分析 | `cjpm build -l` |
| `cjfmt` | 格式化 | `cjfmt -f file.cj`、`cjfmt -f src/` |
| `cjdb` | 调试器 | `cjdb ./target/debug/bin/main` |
| `cjcov` | 覆盖率 | `cjpm build --coverage` → `cjpm test` → `cjcov` |
| `cjprof` | 性能分析 | `cjprof record -o perf.data ./程序` → `cjprof report -i perf.data` |

---

## 2. 项目管理

### 2.1 初始化

```bash
cjpm init --name my_app --type=executable   # 可选: static / dynamic
```

- 始终通过 `cjpm init` 创建项目，不要手动创建 `cjpm.toml`
- 项目名使用小写字母和下划线

### 2.2 cjpm.toml 必填字段

`cjc-version`、`name`、`version`、`output-type` 为必填。

依赖配置：
- 本地：`{ path = "../module_name" }`
- Git：`{ git = "https://...", tag = "v1.0.0" }`（优先 tag，避免 branch）
- 测试依赖放 `[test-dependencies]`，构建脚本依赖放 `[script-dependencies]`

### 2.3 源码结构

```
project/
├── cjpm.toml
├── src/
│   ├── main.cj              # 入口（可执行项目）
│   ├── utils/helper.cj      # 子包（须含 .cj 文件才是有效包）
│   └── utils_test.cj        # 测试文件（同目录）
└── target/                   # 构建输出（勿手动修改）
```

- `package` 声明必须匹配 `src/` 下的相对目录路径
- `src/` 根目录文件属于 `default` 包

### 2.4 多模块 Workspace

```bash
cjpm init --workspace                        # 创建 workspace
cjpm init --type=static --path lib_core      # 添加子模块
```

根 `cjpm.toml` 配置：
```toml
[workspace]
  members = ["./lib_core", "./lib_utils", "./app"]
```

子模块 `cjpm.toml` 中声明依赖：
```toml
[dependencies]
  lib_core = { path = "../lib_core" }
```

关键规则：
- `[workspace]` 和 `[package]` 不能同时存在于同一个 `cjpm.toml`
- 模块间依赖使用相对路径（相对于当前模块的 `cjpm.toml`）
- 每个模块必须有独立的 `cjpm.toml` 和 `src/`
- `cjpm run --name app` 运行指定模块

### 2.5 依赖管理

| 命令 | 用途 |
|------|------|
| `cjpm check` | 检查依赖关系，报告循环依赖 |
| `cjpm tree` | 可视化依赖树 |
| `cjpm update` | 刷新 lock 文件 |

- `cjpm.lock` 应提交到版本控制
- 用 `[replace]` 临时替换间接依赖（仅入口模块的 replace 生效）

### 2.6 包组织规范

- 包声明必须与 `src/` 下目录路径匹配：`src/network/http/client.cj` → `package default.network.http`
- 包嵌套建议不超过 3 层（如 `pkg.sub1.sub2`），过深则应拆为独立模块
- 无 `.cj` 文件的目录不构成有效包，其子目录也会被忽略（cjpm 会警告）
- 库模块应在根包中 `public import` 重新导出子包 API：

```cangjie
// src/lib.cj
package my_lib
public import my_lib.http.HttpClient
public import my_lib.utils.StringHelper
```

| 修饰符 | 可见范围 | 使用场景 |
|--------|---------|---------|
| `private` | 当前文件 | 文件内辅助函数/类型 |
| `internal`（默认） | 包及子包 | 包内共享的实现细节 |
| `protected` | 当前模块 | 模块内跨包共享 |
| `public` | 全局 | 对外暴露的 API |

---

## 3. 构建与运行

| 命令 | 说明 |
|------|------|
| `cjpm build` | Release 构建 |
| `cjpm build -g` | Debug 构建 |
| `cjpm build -V` | 详细日志 |
| `cjpm build -j 4` | 4 线程并行 |
| `cjpm build -i` | 增量编译 |
| `cjpm run` | 构建并运行 |
| `cjpm run --run-args "arg1 arg2"` | 传递参数 |
| `cjpm run --skip-build` | 跳过构建 |
| `cjpm clean` | 清理后重建解决奇怪的编译问题 |

- 使用 `--diagnostic-format=json` 获取结构化错误信息
- 可执行文件位于 `target/release/bin/` 或 `target/debug/bin/`

---

## 4. 测试

### 4.1 行为规则

**重要**：用户未明确要求（如「写单测」「加测试」）时，**不要**主动新建或追加 `*_test.cj`、测试类及用例。日常改动以 `cjpm build` 验证为主。

### 4.2 编写测试

- 测试文件：`xxx_test.cj`，与被测文件同目录
- 使用 `@Test` + `@TestCase` 注解
- 使用 `@BeforeAll`/`@AfterAll`/`@BeforeEach`/`@AfterEach` 管理生命周期
- 使用 `@Assert` 系列宏断言

### 4.3 运行测试

| 命令 | 说明 |
|------|------|
| `cjpm test` | 全部测试 |
| `cjpm test src src/utils` | 指定包 |
| `cjpm test --filter "MyTest*.*"` | 按名称过滤 |
| `cjpm test --timeout-each 10s` | 单测超时 |
| `cjpm test --parallel 4` | 并行执行 |
| `cjpm test --mock` | 启用 mock（需 `[profile.test.build] mock = "on"`） |
| `cjpm test --report-path report --report-format json` | 测试报告 |

---

## 5. 代码质量

执行检查顺序：
1. `cjfmt -f src/` — 格式化
2. `cjpm build -l` — 编译 + lint
3. `cjpm test` — 测试

格式化规则可在 `cangjie-format.toml` 中自定义。

---

## 6. 调试

```bash
cjpm build -g                              # 必须 Debug 构建
cjdb ./target/debug/bin/main               # 启动调试
```

cjdb 命令：`b <file>:<line>` 断点 | `r` 运行 | `n` 单步 | `s` 步入 | `p <expr>` 打印 | `bt` 调用栈 | `c` 继续 | `q` 退出

---

## 7. 覆盖率与性能

```bash
# 覆盖率
cjpm build --coverage && cjpm test && cjcov
cjpm clean --coverage                      # 清理覆盖率数据

# 性能分析
cjprof record -o perf.data ./程序
cjprof report -i perf.data                 # 文本报告
cjprof report -i perf.data --flamegraph    # 火焰图
```

---

## 8. Skill 引用规则

查阅仓颉语言特性或 API 时，按优先级引用：
1. **具体特性 Skill**：如 `cangjie-struct`、`cangjie-class`、`cangjie-function`
2. **标准库 Skill**：`cangjie-std`、`cangjie-stdx`
3. **工具链 Skill**：`cangjie-toolchains`
4. **原始文档 Skill**：`cangjie-full-docs`（当以上不够时）
