# 包的依赖管理

## 概述

在仓颉编程语言中，项目的依赖管理通过 `cjpm`（Cangjie Package Manager）和 `cjpm.toml` 配置文件完成。依赖分为模块内的包依赖（通过 `import` 语句）和模块间的外部依赖（通过 `cjpm.toml` 的 `[dependencies]` 配置）。

## 模块内包依赖

同一模块内的包之间通过 `import` 语句建立依赖关系：

```cangjie
// src/app/main.cj
package app

import app.utils.*        // 导入同模块内的 utils 子包
import app.models.User    // 导入同模块内的特定类型
```

模块内包依赖的规则：
- 不允许循环依赖（包 A 导入包 B，包 B 又导入包 A）
- 使用 `cjpm check` 可以检查并报告循环依赖
- 包的编译顺序由依赖关系自动确定

## 模块间外部依赖

### 在 cjpm.toml 中声明依赖

外部模块的依赖在 `cjpm.toml` 的 `[dependencies]` 段中声明：

```toml
[dependencies]
# 本地路径依赖（路径相对于当前 cjpm.toml 所在目录）
my_lib = { path = "./my_lib" }
utils = { path = "../shared/utils" }

# Git 仓库依赖
remote_lib = { git = "https://gitee.com/user/repo.git", tag = "v1.0.0" }
dev_lib = { git = "https://github.com/user/repo.git", branch = "main" }
pinned_lib = { git = "https://github.com/user/repo.git", commitId = "abc123def" }
```

### 依赖源类型

| 类型 | 语法 | 说明 |
|------|------|------|
| 本地路径 | `{ path = "./relative/path" }` | 适用于 workspace 内的模块间依赖 |
| Git + tag | `{ git = "url", tag = "v1.0.0" }` | 推荐，版本固定，构建可复现 |
| Git + commitId | `{ git = "url", commitId = "sha" }` | 精确固定到某个提交 |
| Git + branch | `{ git = "url", branch = "main" }` | 不推荐，分支内容可能变化 |

优先级：`commitId` > `branch` > `tag`（当多个字段同时存在时）。

### 使用外部依赖

声明依赖后，可以在源代码中直接导入依赖模块的公共 API：

```cangjie
import my_lib.*           // 导入 my_lib 的所有公开声明
import remote_lib.Client  // 导入特定类型
```

注意：只有被标记为 `public` 的声明才能被外部模块导入。

## 测试依赖

仅在测试文件（`xxx_test.cj`）中使用的依赖，在 `[test-dependencies]` 段声明：

```toml
[test-dependencies]
mock_lib = { path = "../mock_lib" }
test_utils = { git = "https://gitee.com/user/test-utils.git", tag = "v2.0.0" }
```

测试依赖不会参与正式构建，仅在 `cjpm test` 时使用。

## 构建脚本依赖

`build.cj` 构建脚本使用的依赖，在 `[script-dependencies]` 段声明：

```toml
[script-dependencies]
build_tools = { path = "./build_tools" }
```

构建脚本依赖独立于 `[dependencies]` 和 `[test-dependencies]`。

## 依赖替换

使用 `[replace]` 段可以替换间接（传递）依赖，常用于本地开发调试：

```toml
[replace]
# 将间接依赖 some_lib 替换为本地版本
some_lib = { path = "./local_some_lib" }
```

注意：只有入口模块（最终构建的模块）的 `[replace]` 生效，子模块的 `replace` 会被忽略。

## 依赖管理命令

| 命令 | 说明 |
|------|------|
| `cjpm check` | 检查依赖有效性，报告循环依赖 |
| `cjpm update` | 同步 `cjpm.toml` 到 `cjpm.lock`，更新版本锁定 |
| `cjpm tree` | 以树形结构展示依赖关系 |
| `cjpm tree -V --depth 3` | 详细模式，限制显示深度 |

## cjpm.lock 文件

- `cjpm build` 时自动生成，记录所有依赖的精确版本信息
- 确保构建的可复现性
- 应提交到版本控制系统
- 使用 `cjpm update` 手动刷新

## 依赖冲突处理

当不同模块依赖同一个库的不同版本时，cjpm 会自动进行版本解析：
- 如果版本兼容，选择满足所有约束的最高版本
- 如果版本不兼容，报告冲突错误
- 使用 `[replace]` 可以强制指定使用特定版本

## 常见问题

### 循环依赖

```
Error: cyclic dependency detected: A -> B -> C -> A
```

解决方法：
1. 使用 `cjpm check` 查看完整的依赖关系图
2. 将共享类型抽取到独立的基础模块中
3. 重新组织模块结构，确保依赖关系单向流动

### 依赖路径不存在

```
Error: dependency 'my_lib' path './my_lib' does not exist
```

解决方法：
1. 检查 `cjpm.toml` 中的路径是否正确（相对于当前 `cjpm.toml` 所在目录）
2. 确认目标目录存在且包含有效的 `cjpm.toml`

### 符号未找到

```
Error: undeclared identifier 'SomeType'
```

解决方法：
1. 确认 `cjpm.toml` 中是否声明了对应依赖
2. 检查 `import` 语句是否正确
3. 确认目标类型是否标记为 `public`
