# 仓颉语法速查（仅列仓颉特有 / 易错语法）

## 1. 类型系统要点

| 类别 | 仓颉特有 / 易错点 |
|------|-------------------|
| 整数 | `IntNative` / `UIntNative`（平台宽度）；无隐式拓宽 |
| 字符 | `Rune`（非 char），支持 `'\u{1F600}'` |
| 字符串 | 插值用 `"${expr}"`（不是 `$expr`） |
| 单元/底 | `Unit`（无返回值），`Nothing`（永不返回，如 throw） |
| Option | 语法糖 `?T` 等价 `Option<T>`；`??` 合并、`?.` 可选链 |
| 元组 | `(Int64, String)` 访问用 `t[0]`（下标，非 `.0`） |
| VArray | `VArray<Int64, $3>` 固定长度值类型数组（FFI 专用） |
| 函数类型 | `(Int64, String) -> Bool` |

## 2. 变量声明

```cangjie
let x = 42          // 不可变（优先）
var y = 0           // 可变
const Z = 100       // 编译期常量（必须大写）
```

## 3. 函数 - 命名参数与 main

```cangjie
// 命名参数（调用时 必须 带名）
func connect(host!: String, port!: Int64 = 8080): Unit { ... }
// 调用: connect(host: "localhost", port: 3000)

// main 必须返回 Int64
main(): Int64 { return 0 }
```

## 3b. Lambda 表达式

```cangjie
let f = { a: Int64, b: Int64 => a + b }     // 推断返回类型
let g: (Int64) -> Int64 = { x => x * 2 }    // 显式函数类型
```

## 3c. 泛型约束

```cangjie
func max<T>(a: T, b: T): T where T <: Comparable<T> { ... }
func process<T>(x: T) where T <: Printable & Hashable { ... }  // 多约束
```

## 3d. type alias

```cangjie
type StringList = ArrayList<String>
type Handler = (String) -> Unit
```

## 4. struct vs class 选择（关键差异）

| | struct（值类型） | class（引用类型） |
|---|---|---|
| 继承 | 不可继承 | 支持单继承 `<:` |
| 自引用 | 禁止递归字段 | 允许 |
| mut 方法 | `mut func` 只能在 `var` 绑定上调用 | 无此限制 |
| 默认选择 | 小型数据优先用 struct | 需要继承/自引用时用 class |

```cangjie
struct Point {
    let x: Float64; let y: Float64
    public mut func reset(): Unit { this = Point(0.0, 0.0) }
}
// let p = Point(1.0, 2.0); p.reset()  // 编译错误！let 不能调 mut
var p = Point(1.0, 2.0); p.reset()     // OK
```

## 5. class 继承 - override vs redef（仓颉独有）

```cangjie
abstract class Shape {
    public open func area(): Float64 { 0.0 }   // open -> 子类可 override
    public func name(): String { "shape" }      // 非 open -> 子类可 redef
}
class Circle <: Shape {
    public override func area(): Float64 { ... }  // override 重写 open 方法
    public redef func name(): String { "circle" } // redef 重定义非 open 成员
}
```

- `override`：重写父类 `open` 方法（多态分派）
- `redef`：重新定义非 `open` 成员（静态分派，仓颉独有概念）
- **子类 init 必须首先调用 `super(...)`**

修饰符：`public / protected / private / internal / open / abstract / static / sealed / override / redef`

`sealed class`：仅在定义模块内可继承

## 6. enum（代数数据类型）

```cangjie
enum Color {
    Red | Green | Blue
    Custom(r: Int64, g: Int64, b: Int64)   // 可带参数

    public func isCustom(): Bool {
        match (this) {
            case Custom(_, _, _) => true
            case _ => false
        }
    }
}
```

## 6b. interface（可带默认实现）

```cangjie
interface Printable {
    func display(): String
    func debugInfo(): String { "default impl" }   // 默认实现
}
class Foo <: Printable {
    public func display(): String { "Foo" }
    // debugInfo 使用默认实现
}
```

## 7. extend（扩展现有类型）

```cangjie
extend String { public func reversed(): String { ... } }

// 通过扩展实现接口
extend Int64 <: Printable { public func display(): String { "${this}" } }
```

## 8. prop 属性

```cangjie
class Temperature {
    private var _celsius: Float64
    public prop celsius: Float64 {
        get() { _celsius }
        set(value) { _celsius = value }
    }
    public prop fahrenheit: Float64 { get() { _celsius * 9.0 / 5.0 + 32.0 } }
}
```

## 9. 控制流易错点

- `if` 是表达式：`let max = if (a > b) { a } else { b }`
- `match` 替代 switch，支持 `where` 守卫：`case n where n > 0 =>`
- 区间：`0..10`（左闭右开）、`0..=10`（左闭右闭）、`0..10 : 2`（步长）
- break/continue 可带标签：`@label for (...) { break @label }`
- for-in 解构：`for ((k, v) in map) { ... }`、`for (i in 0..10 : 2) { ... }`

## 10. 并发

```cangjie
import std.sync.*
let future = spawn { heavyWork() }   // 创建协程
let result = future.get()            // 阻塞等待
synchronized (obj) { sharedData++ }  // 同步块
```

## 10b. 错误处理要点

```cangjie
// try-with-resources（自动关闭 Resource）
try (file = openFile("data.txt")) { file.read() }   // 自动调用 close()

// 自定义异常
class AppError <: Exception {
    public init(msg: String) { super(msg) }
}

// Option 处理
let v: ?Int64 = findValue()
let result = v ?? 0                // 合并
let name = user?.profile?.name     // 可选链
let x = opt.getOrThrow()           // None 时抛 NoneValueException
```

## 11. 包与导入

- `package` 声明必须匹配目录：`src/network/http/client.cj` -> `package default.network.http`
- `src/` 根目录文件属于 `default` 包
- 重新导出：`public import my_lib.http.HttpClient`
- 访问修饰符：`private`（文件）< `internal`（包，默认）< `protected`（模块）< `public`（全局）

## 12. 仓颉特有运算符

```
??   合并运算符（右结合）   let v = opt ?? 0
|>   管道运算符            data |> parse |> validate
~>   组合运算符            let f = parse ~> validate
..   左闭右开区间          0..10
..=  左闭右闭区间          0..=10
```

## 12b. 操作符优先级（从高到低）

```
@  .[]()  ++--?  !-  **  */%  +-  <<>>  ....=  <<=>>=isas  ==!=  &  ^  |  &&  ||  ??  |>~>  =+=-=
```

要点：`**` 和 `??` 右结合；`|>` `~>` 优先级极低（仅高于赋值）

## 13. FFI / foreign

```cangjie
@C("native_add")
foreign func nativeAdd(a: Int64, b: Int64): Int64
```

- `foreign func` 仅声明签名，实现在 native 库中
- 需在构建配置中设置链接库与目标平台

## 14. 运算符重载补充

```cangjie
// 下标访问重载
public operator func [](index: Int64): Float64 { ... }
```
