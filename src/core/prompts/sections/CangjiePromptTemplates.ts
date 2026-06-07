// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
export const CORE_PROJECT_TEMPLATE =
	"## 仓颉代码模板\n\n" +
	'### 可执行项目入口\n```cangjie\npackage my_app\nimport std.console.*\nmain(): Int64 {\n    println("Hello, Cangjie!")\n    return 0\n}\n```\n'

export const TEST_FILE_TEMPLATE =
	"### 测试文件模板\n```cangjie\npackage my_app\nimport std.unittest.*\nimport std.unittest.testmacro.*\n@Test\nclass MyTest {\n    @TestCase\n    func testBasic() {\n        @Assert(1 + 1 == 2)\n    }\n}\n```\n"

export const COMMON_ERROR_TABLE_TEMPLATE =
	"### 常见编译错误速查\n" +
	"| 错误类型 | 解决方案 |\n" +
	"|----------|----------|\n" +
	"| 未找到符号 | 检查 import 语句和 cjpm.toml 依赖 |\n" +
	"| 类型不匹配 | 检查类型声明和转换 |\n" +
	"| let 变量赋值 | 改用 `var` 声明 |\n" +
	"| mut 函数限制 | let 变量调用 mut 函数 -> 改用 `var` |\n" +
	"| 递归结构体 | struct 不能自引用 -> 改用 class 或 Option |\n" +
	"| match 不穷尽 | 补全 case 或添加 `case _ =>` |\n" +
	"| 参数数量错误 | 检查命名参数需用 `name:` 语法 |\n" +
	"| redef/override 混淆 | 检查父方法是否 open；open 用 override，非 open 用 redef |\n" +
	"| sealed 类限制 | 仅在定义模块内继承 sealed class |\n" +
	"| init 顺序错误 | 子类 init 首行调用 super() |\n"

export const DIAGNOSTIC_CODE_TEMPLATES: Array<{ categories: string[]; template: string }> = [
	{
		categories: ["类型不匹配", "类型转换失败"],
		template:
			"### 类型转换速查\n" +
			'- `Int64 -> String`: `"${value}"` 或 `value.toString()`\n' +
			"- `String -> Int64`: `Int64.parse(str)` 返回 `?Int64`\n" +
			"- `Float64 -> Int64`: `Int64(floatVal)` (截断)\n" +
			"- `Array<T> -> ArrayList<T>`: `ArrayList<T>(arr)`\n" +
			"- `?T -> T`: `opt ?? defaultVal` 或 `match(opt) { case Some(v) => v; case None => ... }`\n",
	},
	{
		categories: ["未找到符号", "缺少 import"],
		template:
			"### 常用 import 路径速查\n" +
			"- 集合: `import std.collection.*`\n" +
			"- IO: `import std.io.*` + `import std.fs.*`\n" +
			"- 控制台: `import std.console.*`\n" +
			"- 测试: `import std.unittest.*` + `import std.unittest.testmacro.*`\n" +
			"- 并发: `import std.sync.*`\n" +
			"- 网络: `import std.net.*`\n" +
			"- 正则: `import std.regex.*`\n" +
			"- 格式化: `import std.format.*`\n",
	},
	{
		categories: ["mut 函数限制", "不可变变量赋值"],
		template:
			"### let / var / mut 对照\n" +
			"- `let x = value` - 不可变绑定，不能重新赋值，不能调用 mut 方法\n" +
			"- `var x = value` - 可变绑定，可重新赋值，可调用 mut 方法\n" +
			"- `mut func foo()` - 修改 struct 自身字段的方法，调用者必须是 var 绑定\n" +
			"- **修复**: 将 `let obj = Struct()` 改为 `var obj = Struct()` 后再调用 `obj.mutMethod()`\n",
	},
	{
		categories: ["接口未实现", "接口未实现（精确）"],
		template:
			"### interface 实现模板\n" +
			"```cangjie\ninterface Printable {\n    func display(): String\n}\n" +
			'class MyClass <: Printable {\n    public func display(): String {\n        return "MyClass"\n    }\n}\n```\n',
	},
]

export function pushTemplateWithinBudget(parts: string[], budget: number, template: string): number {
	if (budget >= template.length) {
		parts.push(template)
		return budget - template.length
	}
	return budget
}
