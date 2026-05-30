# 测试指南

本文档介绍如何为 NJUST_AI 项目编写和运行测试。

## 目录

- [测试架构](#测试架构)
- [运行测试](#运行测试)
- [编写测试](#编写测试)
- [覆盖率](#覆盖率)
- [E2E 测试](#e2e-测试)

## 测试架构

```
NJUST_AI (Monorepo - pnpm + turbo)
│
├── src/                              # VS Code 扩展主包
│   ├── vitest.config.ts              # Vitest 配置
│   ├── vitest.setup.ts               # 全局 setup (nock 禁网)
│   ├── __mocks__/                    # VS Code API mock
│   └── **/*.spec.ts                  # 单元测试
│
├── webview-ui/                       # React Webview UI
│   ├── vitest.config.ts              # Vitest 配置 (jsdom)
│   ├── vitest.setup.ts               # 全局 setup (jest-dom)
│   ├── src/__mocks__/                # 组件 mock
│   └── src/**/*.spec.tsx             # UI 组件测试
│
├── packages/                         # 共享包
│   ├── core/                         # 核心逻辑
│   ├── types/                        # 类型定义
│   └── vscode-shim/                  # VS Code shim
│
└── apps/
    └── vscode-e2e/                   # E2E 测试 (Mocha + @vscode/test-electron)
```

### 测试框架

| 包 | 测试框架 | 环境 |
|---|---------|------|
| `src/` | Vitest | Node.js |
| `webview-ui/` | Vitest + jsdom | 浏览器模拟 |
| `packages/*` | Vitest | Node.js |
| `apps/vscode-e2e/` | Mocha + @vscode/test-electron | VS Code 实例 |

## 运行测试

### 运行所有测试

```bash
pnpm test
```

### 运行特定包的测试

```bash
# src 包
pnpm --filter njust-ai test

# webview-ui 包
pnpm --filter @njust-ai/vscode-webview test

# packages/core 包
pnpm --filter @njust-ai/core test
```

### 运行覆盖率报告

```bash
# src 覆盖率
pnpm test:coverage

# webview-ui 覆盖率
pnpm --filter @njust-ai/vscode-webview test:coverage
```

### 运行单个测试文件

```bash
cd src
pnpm vitest run path/to/test.spec.ts
```

### 监听模式

```bash
cd src
pnpm vitest watch
```

## 编写测试

### 文件命名规范

- 测试文件：`*.spec.ts` 或 `*.spec.tsx`
- 测试目录：`__tests__/`
- Mock 文件：`__mocks__/`

### 基本结构

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest"

describe("MyFunction", () => {
  beforeEach(() => {
    // 清理 mock
    vi.clearAllMocks()
  })

  it("should do something", () => {
    // Arrange
    const input = "test"

    // Act
    const result = myFunction(input)

    // Assert
    expect(result).toBe("expected")
  })

  it("should handle errors", () => {
    expect(() => myFunction(null)).toThrow("Invalid input")
  })
})
```

### Mock VS Code API

```typescript
// 使用自动 mock
import { vscode } from "../__mocks__/vscode"

// 或者手动 mock
vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(),
  },
}))
```

### Mock 文件系统

```typescript
import { vol } from "memfs"

vi.mock("fs/promises", async () => {
  const memfs = await vi.importActual("memfs")
  return memfs.fs.promises
})

beforeEach(() => {
  vol.reset()
  vol.writeFileSync("/test/file.txt", "content")
})
```

### 测试 React 组件

```typescript
import { render, screen, fireEvent } from "@testing-library/react"
import { MyComponent } from "./MyComponent"

describe("MyComponent", () => {
  it("renders correctly", () => {
    render(<MyComponent />)
    expect(screen.getByText("Hello")).toBeInTheDocument()
  })

  it("handles click", () => {
    const onClick = vi.fn()
    render(<MyComponent onClick={onClick} />)
    fireEvent.click(screen.getByRole("button"))
    expect(onClick).toHaveBeenCalled()
  })
})
```

## 覆盖率

### 查看覆盖率报告

```bash
# 生成 HTML 报告
pnpm test:coverage

# 查看报告
open coverage/src/index.html
```

### 覆盖率门槛

| 包 | 行覆盖 | 函数覆盖 | 分支覆盖 |
|---|--------|---------|---------|
| `src/` | 60% | 50% | 40% |
| `webview-ui/` | 50% | 40% | 30% |

### Codecov 集成

覆盖率报告会自动上传到 Codecov。在 PR 中会显示覆盖率变化。

访问 https://codecov.io 查看详细报告。

## E2E 测试

### 运行 E2E 测试

```bash
cd apps/vscode-e2e
pnpm test
```

### Mock API 模式

E2E 测试使用 Mock API 服务器，不依赖真实的 LLM API。

```typescript
import { createMockServer } from "@njust-ai/mock-api-server"

suite("My E2E Test", () => {
  let server

  suiteSetup(() => {
    const app = createMockServer()
    server = app.listen(3000)
  })

  suiteTeardown(() => {
    server.close()
  })

  test("should work", async () => {
    // 测试逻辑
  })
})
```

## 最佳实践

1. **测试命名**: 使用描述性的测试名称，说明预期行为
2. **AAA 模式**: Arrange（准备）、Act（执行）、Assert（断言）
3. **隔离测试**: 每个测试应该独立，不依赖其他测试的状态
4. **Mock 策略**: 只 mock 必要的依赖，避免过度 mock
5. **边界条件**: 测试正常路径、错误路径和边界条件
6. **避免硬编码**: 使用变量存储测试数据，便于维护

## 常见问题

### Q: 测试运行缓慢怎么办？

A: 使用 `vi.mock()` mock 掉慢速依赖（如文件系统、网络请求），或使用 `--reporter=dot` 减少输出。

### Q: 如何调试测试？

A: 使用 `console.log` 或 Vitest UI：

```bash
cd src
pnpm vitest --ui
```

### Q: 覆盖率报告不准确？

A: 检查 `vitest.config.ts` 中的 `coverage.include` 和 `coverage.exclude` 配置。

## 相关文档

- [Vitest 文档](https://vitest.dev/)
- [Testing Library 文档](https://testing-library.com/)
- [Codecov 文档](https://docs.codecov.io/)
