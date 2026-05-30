# 仓颉语言编码规则

## 1. 项目文件模板

### 1.1 可执行项目 main.cj

```cangjie
package my_app

import std.console.*

main(): Int64 {
    println("Hello, Cangjie!")
    return 0
}
```

### 1.2 库项目入口

```cangjie
package my_lib

public func greet(name: String): String {
    return "Hello, ${name}!"
}
```

### 1.3 测试文件模板 (xxx_test.cj)

```cangjie
package my_app

import std.unittest.*
import std.unittest.testmacro.*

@Test
class MyTest {
    @TestCase
    func testBasic() {
        @Assert(1 + 1 == 2)
    }
}
```

---

## 2. 实用代码模式

### 2.1 并发（spawn / future）

```cangjie
import std.sync.*

let future = spawn { heavyComputation() }
let result = future.get()
```

### 2.2 运算符重载

```cangjie
class Counter {
    let value: Int64
    public init(value: Int64) { this.value = value }
    public operator func +(rhs: Counter): Counter { Counter(this.value + rhs.value) }
}
```

### 2.3 文件 I/O

```cangjie
import std.fs.*
import std.io.*

func readText(path: String): String {
    let file = File(path)
    let input = file.openInputStream()
    try { input.readToEndAsString() } finally { input.close() }
}
```

### 2.4 类型转换

```cangjie
let s = "123"
let n = Int64.parse(s)            // 字符串转 Int64
let text = n.toString()           // 数值转字符串

let x: Any = 42
let y = x as? Int64               // 安全转换（失败返回 None）
let z = x as Int64                // 明确知道类型时使用
```

### 2.5 Option 使用

```cangjie
func findUser(id: Int64): ?User {
    if (id > 0) { return Some(User(id)) }
    return None
}
let user = findUser(1) ?? defaultUser
```

### 2.6 集合操作

```cangjie
import std.collection.*

// HashMap
let map = HashMap<String, Int64>()
map.put("alice", 1)
let v = map.get("alice") ?? 0
for ((k, v) in map) { println("${k} -> ${v}") }

// ArrayList
let list = ArrayList<String>()
list.append("a")
for (item in list) { println(item) }
```

### 2.7 模式匹配

```cangjie
match (value) {
    case 0 => println("zero")
    case n where n > 0 => println("positive: ${n}")
    case _ => println("negative")
}
```

---

## 3. 易错点速查

| 错误类型 | 常见原因 | 解决方案 |
|----------|----------|----------|
| 未找到符号 | 缺少 import 或包依赖 | 检查 import 和 cjpm.toml 依赖 |
| 类型不匹配 | 赋值或传参类型错误 | 检查类型声明和转换 |
| 循环依赖 | 包之间互相引用 | `cjpm check` 查看，重构拆分 |
| let 变量赋值 | 尝试修改不可变变量 | 改用 `var` |
| mut 函数限制 | let 变量调用 mut 函数 | 改用 `var` 声明变量 |
| 递归结构体 | struct 直接或间接自引用 | 改用 class 或 Option 包装 |
| redef/override 混淆 | open 方法误用 redef | open → override，非 open → redef |
| sealed 类限制 | 跨模块继承 sealed class | 仅在定义模块内继承 |
| init 顺序错误 | super() 未在子类 init 首行 | 子类 init 第一步调用 super() |
| Lambda 类型推断 | 复杂 Lambda 缺少标注 | 显式标注参数和返回类型 |

---

## 4. cjpm.toml 必填字段速查

```toml
[package]
  cjc-version = "0.55.3"
  name = "my_app"
  version = "1.0.0"
  output-type = "executable"   # executable / static / dynamic
```
