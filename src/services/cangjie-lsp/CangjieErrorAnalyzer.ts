import * as path from "path"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CjcErrorPattern {
	pattern: RegExp
	category: string
	docPaths: string[]
	/** Human/long form for docs and tables */
	suggestion: string
	/** Short AI-facing directive; defaults to suggestion when absent */
	fixDirective?: string
	/**
	 * When multiple patterns match, higher priority wins (default 0).
	 * Use for more specific patterns that should override broad regexes.
	 */
	priority?: number
	/**
	 * Compiler / LSP diagnostic codes (e.g. E1234) when stable; fills code → pattern maps.
	 */
	diagnosticCodes?: string[]
	/**
	 * Categories fully subsumed by this pattern — when this pattern matches,
	 * those categories are removed from the result set to avoid redundant suggestions.
	 */
	subsumes?: string[]
}

export interface DocMapping {
	prefix: string
	docPaths: string[]
	summary: string
}

export interface ErrorAnalysis {
	category: string
	docHints: { relPaths: string[]; rationale: string }
	suggestion: string
	errorKeys: string[]
}

// ---------------------------------------------------------------------------
// Standard library documentation mapping
// ---------------------------------------------------------------------------

export const STDLIB_DOC_MAP: DocMapping[] = [
	{ prefix: "std.collection", docPaths: ["libs/std/collection/", "manual/source_zh_cn/collections/"], summary: "ArrayList, HashMap, HashSet 等集合类型" },
	{ prefix: "std.io", docPaths: ["libs/std/io/", "manual/source_zh_cn/Basic_IO/"], summary: "流式 IO、文件读写" },
	{ prefix: "std.fs", docPaths: ["libs/std/fs/"], summary: "文件系统操作" },
	{ prefix: "std.net", docPaths: ["libs/std/net/", "manual/source_zh_cn/Net/"], summary: "HTTP/Socket/WebSocket 网络编程" },
	{ prefix: "std.sync", docPaths: ["libs/std/sync/", "manual/source_zh_cn/concurrency/"], summary: "Mutex、AtomicInt 等并发同步原语" },
	{ prefix: "std.time", docPaths: ["libs/std/time/"], summary: "日期时间处理" },
	{ prefix: "std.math", docPaths: ["libs/std/math/"], summary: "数学运算" },
	{ prefix: "std.regex", docPaths: ["libs/std/regex/"], summary: "正则表达式" },
	{ prefix: "std.console", docPaths: ["libs/std/console/"], summary: "控制台输入输出" },
	{ prefix: "std.convert", docPaths: ["libs/std/convert/"], summary: "类型转换" },
	{ prefix: "std.unittest", docPaths: ["libs/std/unittest/"], summary: "单元测试框架 (@Test, @TestCase, @Assert)" },
	{ prefix: "std.objectpool", docPaths: ["libs/std/objectpool/"], summary: "对象池与复用" },
	{ prefix: "std.unicode", docPaths: ["libs/std/unicode/"], summary: "Unicode 字符处理" },
	{ prefix: "std.log", docPaths: ["libs/std/log/"], summary: "日志框架" },
	{ prefix: "std.ffi", docPaths: ["libs/std/ffi/"], summary: "FFI 外部函数接口" },
	{ prefix: "std.format", docPaths: ["libs/std/format/"], summary: "格式化输出" },
	{ prefix: "std.random", docPaths: ["libs/std/random/"], summary: "随机数生成" },
	{ prefix: "std.process", docPaths: ["libs/std/process/"], summary: "进程管理" },
	{ prefix: "std.env", docPaths: ["libs/std/env/"], summary: "环境变量" },
	{ prefix: "std.reflect", docPaths: ["libs/std/reflect/", "manual/source_zh_cn/reflect_and_annotation/"], summary: "反射与注解" },
	{ prefix: "std.sort", docPaths: ["libs/std/sort/"], summary: "排序算法" },
	{ prefix: "std.binary", docPaths: ["libs/std/binary/"], summary: "二进制数据处理" },
	{ prefix: "std.ast", docPaths: ["libs/std/ast/"], summary: "AST 操作（宏编程）" },
	{ prefix: "std.crypto", docPaths: ["libs/std/crypto/"], summary: "加密与哈希" },
	{ prefix: "std.database", docPaths: ["libs/std/database/"], summary: "数据库 SQL 接口" },
	{ prefix: "std.core", docPaths: ["libs/std/core/"], summary: "核心类型与函数（自动导入）" },
	{ prefix: "std.deriving", docPaths: ["libs/std/deriving/"], summary: "自动派生宏" },
	{ prefix: "std.overflow", docPaths: ["libs/std/overflow/"], summary: "溢出安全运算" },
]

// ---------------------------------------------------------------------------
// Compiler error patterns
// ---------------------------------------------------------------------------

/** Build LSP/compiler code → pattern map from pattern `diagnosticCodes`. */
export function buildCjcDiagnosticCodeMap(patterns: readonly CjcErrorPattern[]): ReadonlyMap<string, CjcErrorPattern> {
	const m = new Map<string, CjcErrorPattern>()
	for (const p of patterns) {
		for (const code of p.diagnosticCodes ?? []) {
			if (!m.has(code)) m.set(code, p)
		}
	}
	return m
}

export const CJC_ERROR_PATTERNS: CjcErrorPattern[] = [
	{
		pattern: /foreign function.*not found|@C\b|ffi.*not found|link.*foreign/i,
		category: "FFI 链接/声明",
		docPaths: ["manual/source_zh_cn/reflect_and_annotation/"],
		suggestion:
			"核对 `@C` / foreign 函数声明是否与 native 库导出符号一致，检查链接参数与 cjpm.toml 中目标平台的 FFI 配置",
		fixDirective: "检查 FFI 声明、@C 注解与链接配置（库路径、符号名、mangling）是否一致",
		priority: 72,
		subsumes: ["未找到符号"],
	},
	{
		pattern: /macro expansion failed|@Macro|宏展开失败|expand macro/i,
		category: "宏展开失败",
		docPaths: ["manual/source_zh_cn/Macro/", "libs/std/ast/"],
		suggestion: "检查宏参数类型、引用位置与展开结果是否符合语法；查看宏定义与调用处模板是否匹配",
		fixDirective: "检查 @Macro 参数类型与展开体语法，必要时简化宏或拆分展开步骤",
		priority: 71,
	},
	{
		pattern: /cannot instantiate.*generic|could not instantiate.*generic|泛型实例化|type instantiation/i,
		category: "泛型实例化失败",
		docPaths: ["manual/source_zh_cn/generic/generic_constraint.md", "manual/source_zh_cn/generic/"],
		suggestion: "确认类型实参满足 where 与子类型约束，必要时显式标注类型参数",
		fixDirective: "检查泛型实参与 where T <: Trait 约束，显式标注类型或调整边界",
		priority: 68,
	},
	{
		pattern: /redef.*override|override.*redef|override.*open|cannot override|non-open/i,
		category: "redef/override 混淆",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md"],
		suggestion: "open 方法应使用 override，非 open 方法应使用 redef，需与父类声明保持一致",
		fixDirective: "检查父方法是否 open；open 用 override，非 open 用 redef",
		priority: 69,
	},
	{
		pattern: /sealed.*cannot|sealed.*extend|sealed class|密封类/i,
		category: "sealed 类限制",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md", "manual/source_zh_cn/package/package_overview.md"],
		suggestion: "sealed class 仅允许在定义模块内继承，跨模块继承会失败",
		fixDirective: "仅在 sealed class 定义模块内继承，或改为 open/abstract 设计",
		priority: 65,
	},
	{
		pattern: /init.*before|member.*init|初始化顺序|super.*before|must call super/i,
		category: "init 初始化顺序错误",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md"],
		suggestion: "子类 init 中必须先调用 super()，再访问或初始化当前类成员",
		fixDirective: "子类 init 第一步调用 super()，再初始化成员",
		priority: 64,
	},
	{
		pattern: /data race|shared.*mutable|mutable.*shared|并发.*共享.*可变/i,
		category: "并发共享可变",
		docPaths: ["manual/source_zh_cn/concurrency/", "libs/std/sync/"],
		suggestion: "共享可变状态应使用 Mutex、synchronized 或原子类型，避免跨线程裸可变别名",
		fixDirective: "用 Mutex / synchronized / Atomic 包装共享可变状态，缩小可变作用域",
		priority: 70,
		subsumes: ["spawn 捕获可变引用"],
	},
	{
		pattern: /package.*does not match.*directory|package.*目录|directory.*package.*mismatch/i,
		category: "包声明与目录不一致",
		docPaths: ["manual/source_zh_cn/package/import.md", "manual/source_zh_cn/package/package_overview.md"],
		suggestion: "使 `package` 声明与 `src/` 下相对目录路径一致，或调整文件位置",
		fixDirective: "将 package 声明改为与目录推导一致（见项目包结构提示）",
		priority: 75,
	},
	{
		pattern: /operator.*not defined for|运算符.*未定义|no operator/i,
		category: "运算符未重载",
		docPaths: ["manual/source_zh_cn/class_and_interface/"],
		suggestion: "为自定义类型实现 `operator func` 所需运算符，并满足签名与可见性",
		fixDirective: "为目标类型添加 `operator func +(rhs: T): T` 等运算符实现",
		priority: 67,
	},
	{
		pattern: /does not implement.*interface|missing method|未实现.*接口方法|interface.*not satisfied/i,
		category: "接口未实现（精确）",
		docPaths: ["manual/source_zh_cn/class_and_interface/interface.md"],
		suggestion: "补全接口要求的全部方法，签名（含 mut/async）与泛型须与接口声明一致",
		fixDirective: "实现接口中缺失的方法并保证签名完全一致（含泛型与 mut）",
		priority: 66,
		subsumes: ["接口未实现", "Resource 接口未实现"],
	},
	{
		pattern: /cannot access.*\b(private|protected)\b|无权访问.*私|protected.*access/i,
		category: "访问控制（精确）",
		docPaths: ["manual/source_zh_cn/package/toplevel_access.md", "manual/source_zh_cn/extension/access_rules.md"],
		suggestion: "调整成员可见性为 public，或将调用移入同包/子类可见范围",
		fixDirective: "检查 public/protected/private/internal，跨包需 public 或调整调用位置",
		priority: 73,
		subsumes: ["访问权限错误"],
	},
	{
		pattern: /(?:undeclared|cannot find|not found|未找到符号|unresolved)/i,
		category: "未找到符号",
		docPaths: ["manual/source_zh_cn/package/import.md"],
		suggestion: "检查 import 语句是否正确，确认 cjpm.toml 中是否声明了依赖包",
		fixDirective:
			"检查是否缺少 import 语句或拼写错误。如果是标准库符号，添加正确的 import（如 `import std.collection.*`）",
		diagnosticCodes: ["E0001", "E0002", "E0433"],
	},
	{
		pattern: /(?:type mismatch|incompatible types|类型不匹配)/i,
		category: "类型不匹配",
		docPaths: ["manual/source_zh_cn/class_and_interface/typecast.md", "manual/source_zh_cn/class_and_interface/subtype.md"],
		suggestion: "检查赋值和参数的类型是否一致，必要时使用类型转换或泛型约束",
		fixDirective: "使类型一致：修改变量类型、添加显式类型转换、或调整函数返回类型",
		diagnosticCodes: ["E0308", "E0309"],
	},
	{
		pattern: /(?:cyclic dependency|循环依赖)/i,
		category: "循环依赖",
		docPaths: ["manual/source_zh_cn/package/package_overview.md"],
		suggestion: "使用 `cjpm check` 查看依赖关系图，将共享类型抽取到独立包中打破循环",
		fixDirective: "将共享类型抽取到独立包中以打破循环依赖",
		diagnosticCodes: ["E0391"],
	},
	{
		pattern: /(?:immutable|cannot assign|let.*reassign|不可变)/i,
		category: "不可变变量赋值",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/expression.md"],
		suggestion: "将 `let` 改为 `var` 声明，或重新设计为不可变模式",
		fixDirective: "将 `let` 改为 `var`，或重构为不需要重新赋值的模式",
		diagnosticCodes: ["E0384"],
	},
	{
		pattern: /(?:mut function|mut.*let|let.*mut)/i,
		category: "mut 函数限制",
		docPaths: ["manual/source_zh_cn/struct/mut.md"],
		suggestion: "let 绑定的 struct 变量不能调用 mut 函数，改用 var 声明",
		fixDirective: "将 `let` 改为 `var` 以允许调用 mut 方法",
		diagnosticCodes: ["E0596"],
	},
	{
		pattern: /(?:recursive struct|recursive value type|递归结构体)/i,
		category: "递归结构体",
		docPaths: ["manual/source_zh_cn/struct/define_struct.md", "manual/source_zh_cn/class_and_interface/class.md"],
		suggestion: "struct 是值类型不能自引用，改用 class（引用类型）或 Option 包装",
		fixDirective: "将 struct 改为 class 以支持自引用，或用 ?T (Option) 包装",
		diagnosticCodes: ["E0072"],
	},
	{
		pattern: /(?:overflow|arithmetic.*overflow)/i,
		category: "算术溢出",
		docPaths: ["manual/source_zh_cn/error_handle/common_runtime_exceptions.md"],
		suggestion: "使用 std.overflow 包中的溢出安全运算，或检查边界条件",
		fixDirective: "使用 std.overflow 安全运算或添加边界检查",
		diagnosticCodes: ["E0080"],
	},
	{
		pattern: /(?:NoneValueException|unwrap.*None|getOrThrow)/i,
		category: "空值异常",
		docPaths: ["manual/source_zh_cn/error_handle/use_option.md", "manual/source_zh_cn/enum_and_pattern_match/option_type.md"],
		suggestion: "使用 `??` 合并运算符提供默认值，或用 match/if-let 安全解包 Option",
		fixDirective: "用 ?? 提供默认值，或用 match/if-let 安全解包",
		diagnosticCodes: ["E0505"],
	},
	{
		pattern: /(?:not implement|missing implementation|未实现接口)/i,
		category: "接口未实现",
		docPaths: ["manual/source_zh_cn/class_and_interface/interface.md"],
		suggestion: "检查类是否完整实现了所有接口方法，注意方法签名必须完全匹配",
		fixDirective: "实现缺失的接口方法，确保方法签名完全匹配",
		priority: 40,
		diagnosticCodes: ["E0046"],
	},
	{
		pattern: /interpolation|string.*\$|插值|string template/i,
		category: "字符串插值语法错误",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/string.md"],
		suggestion: "字符串插值需使用 ${expr}，花括号内只能是表达式",
		fixDirective: "使用 ${expr} 形式插值，花括号内仅放表达式",
		priority: 55,
		diagnosticCodes: ["E0750"],
	},
	{
		pattern: /lambda.*return|closure.*type|cannot infer.*lambda|闭包.*类型/i,
		category: "Lambda 返回类型推断失败",
		docPaths: ["manual/source_zh_cn/function/define_functions.md"],
		suggestion: "复杂 Lambda 无法推断时需要显式标注参数和返回类型",
		fixDirective: "显式标注 Lambda 参数与返回类型",
		priority: 52,
		diagnosticCodes: ["E0282", "E0283"],
	},
	{
		pattern: /cannot convert|conversion.*failed|无法转换|as.*failed/i,
		category: "类型转换失败",
		docPaths: ["manual/source_zh_cn/class_and_interface/typecast.md", "manual/source_zh_cn/convert/"],
		suggestion: "区分 as 安全转换与显式构造/parse，必要时检查类型边界",
		fixDirective: "区分 as 安全转换与显式构造/parse；必要时显式构造",
		priority: 48,
		diagnosticCodes: ["E0605", "E0606"],
	},
	{
		pattern: /unused\s+(?:variable|import|parameter|function)/i,
		category: "未使用符号",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/identifier.md"],
		suggestion: "移除未使用的变量/导入/参数/函数，或用 `_` 前缀标记",
		fixDirective: "移除未使用的变量/导入/参数/函数，或用 `_` 前缀标记",
		priority: 10,
		diagnosticCodes: ["W0001", "W0611"],
	},
	{
		pattern: /(?:access.*denied|private|protected|not accessible|访问权限)/i,
		category: "访问权限错误",
		docPaths: ["manual/source_zh_cn/package/toplevel_access.md", "manual/source_zh_cn/extension/access_rules.md"],
		suggestion: "检查成员的访问修饰符（public/protected/private/internal），跨包访问需要 public",
		fixDirective: "检查访问修饰符，跨包使用需要 `public`",
		priority: 28,
		diagnosticCodes: ["E0603"],
	},
	{
		pattern: /(?:missing return|no return|缺少返回|return expected)/i,
		category: "缺少 return 语句",
		docPaths: ["manual/source_zh_cn/function/define_functions.md"],
		suggestion: "非 Unit 返回类型的函数所有分支必须有 return 语句，或将最后一个表达式作为返回值",
		fixDirective: "确保函数所有分支都有返回值，或在函数末尾添加返回语句",
		diagnosticCodes: ["E0317"],
	},
	{
		pattern: /(?:wrong number.*argument|too (?:many|few) argument|参数数量|arity)/i,
		category: "函数参数数量错误",
		docPaths: ["manual/source_zh_cn/function/call_functions.md"],
		suggestion: "检查函数调用的参数数量是否与声明匹配，注意命名参数需要用 `name:` 语法",
		fixDirective: "调整函数调用的参数数量或顺序以匹配函数声明",
		diagnosticCodes: ["E0061"],
	},
	{
		pattern: /(?:missing import|import.*not found|未导入)/i,
		category: "缺少 import",
		docPaths: ["manual/source_zh_cn/package/import.md"],
		suggestion: "添加缺失的 import 语句，如 `import std.collection.*` 或 `import std.io.*`",
		fixDirective: "添加缺失的 import 语句（如 import std.collection.*）",
		diagnosticCodes: ["E0432"],
	},
	{
		pattern: /(?:non-exhaustive|not exhaustive|未穷尽|incomplete match)/i,
		category: "match 不穷尽",
		docPaths: ["manual/source_zh_cn/enum_and_pattern_match/match.md"],
		suggestion: "match 表达式必须覆盖所有可能的值，添加缺失的 case 分支或使用 `case _ =>` 通配",
		fixDirective: "为 match 表达式添加缺失的分支或 `case _ =>` 通配分支",
		diagnosticCodes: ["E0004"],
	},
	{
		pattern: /(?:constraint.*not satisfied|does not conform|泛型约束|type parameter.*bound)/i,
		category: "泛型约束不满足",
		docPaths: ["manual/source_zh_cn/generic/generic_constraint.md"],
		suggestion: "检查类型参数是否满足 where 子句中的约束（如 `<: Comparable<T>`），必要时添加约束或换用其他类型",
		fixDirective: "确保类型参数满足 where 子句中的约束",
		priority: 45,
		diagnosticCodes: ["E0277"],
	},
	{
		pattern: /(?:constructor.*argument|init.*parameter|构造.*参数)/i,
		category: "构造函数参数错误",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md", "manual/source_zh_cn/struct/create_instance.md"],
		suggestion: "检查构造函数 init 的参数列表与调用处是否匹配",
		fixDirective: "核对 init 声明的参数列表与调用处的参数类型和数量",
		diagnosticCodes: ["E0063"],
	},
	{
		pattern: /(?:duplicate.*definition|redefinition|already defined|重复定义)/i,
		category: "重复定义",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/identifier.md"],
		suggestion: "同一作用域内不能有同名定义，检查是否重复声明了变量、函数或类型",
		fixDirective: "移除重复定义，或为同名符号使用不同的名称",
	},
	{
		pattern: /(?:main.*signature|main.*return|main.*Int64)/i,
		category: "main 函数签名错误",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/program_structure.md"],
		suggestion: "main 函数签名必须为 `main(): Int64`，必须返回 Int64 类型",
		fixDirective: "修正为 main(): Int64，确保返回 Int64",
	},
	{
		pattern: /(?:Resource.*interface|isClosed|close.*not.*implement)/i,
		category: "Resource 接口未实现",
		docPaths: ["manual/source_zh_cn/error_handle/handle.md"],
		suggestion: "try-with-resources 中的对象必须实现 Resource 接口（isClosed() 和 close() 方法）",
		fixDirective: "为 try-with-resources 对象实现 isClosed() 和 close()",
	},
	{
		pattern: /(?:override.*missing|must.*override|需要.*override|override.*required)/i,
		category: "缺少 override 修饰符",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md"],
		suggestion: "重写父类方法必须使用 `override` 关键字，重定义使用 `redef`",
		fixDirective: "在重写的方法前添加 `override` 关键字",
	},
	{
		pattern: /(?:index.*out.*bound|IndexOutOfBounds|数组越界|下标越界)/i,
		category: "索引越界",
		docPaths: ["manual/source_zh_cn/error_handle/common_runtime_exceptions.md"],
		suggestion: "访问数组/字符串前检查索引范围，使用 `.size` 获取长度",
		fixDirective: "访问前检查 .size 范围，使用安全的索引方式",
	},
	{
		pattern: /(?:capture.*mutable|spawn.*var|并发.*可变)/i,
		category: "spawn 捕获可变引用",
		docPaths: ["manual/source_zh_cn/concurrency/create_thread.md"],
		suggestion: "spawn 块内不能直接捕获可变引用，使用 Mutex/Atomic 保护共享状态",
		fixDirective: "使用 Mutex 或 AtomicReference 包装共享可变状态",
		priority: 50,
	},
	{
		pattern: /(?:where.*clause|where.*syntax|where.*error)/i,
		category: "where 子句语法错误",
		docPaths: ["manual/source_zh_cn/generic/generic_constraint.md"],
		suggestion: "where 子句语法: `where T <: Interface`，多约束用 `&` 连接: `where T <: A & B`",
		fixDirective: "检查 where 语法：where T <: Interface，多约束用 & 连接",
	},
	{
		pattern: /(?:prop.*getter|prop.*setter|属性.*语法)/i,
		category: "prop 语法错误",
		docPaths: ["manual/source_zh_cn/class_and_interface/prop.md"],
		suggestion: "属性语法: `prop name: Type { get() { ... } set(v) { ... } }`，只读属性可省略 set",
		fixDirective: "使用 prop name: Type { get() { ... } set(v) { ... } } 语法",
	},
	{
		pattern: /(?:expected.*semicolon|expected.*bracket|expected.*paren|语法错误|syntax error|unexpected token)/i,
		category: "语法解析错误",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/expression.md"],
		suggestion: "检查括号/花括号是否匹配，语句是否完整。注意仓颉不使用分号结尾（除非同一行多条语句）",
		fixDirective: "检查括号/花括号匹配，确保语句完整。注意仓颉不使用分号结尾",
	},
	{
		pattern: /(?:invalid.*literal.*suffix|literal.*suffix|unknown.*suffix|字面量.*后缀)/i,
		category: "字面量后缀错误",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/literal.md"],
		suggestion: "仓颉整数字面量默认为 Int64，浮点为 Float64。不支持自定义字面量后缀。需要其他类型时使用显式构造如 UInt8(42)。",
		fixDirective: "移除无效的字面量后缀，使用显式类型构造（如 UInt8(42)、Float32(3.14)）",
		priority: 55,
	},
	{
		pattern: /(?:named.*argument.*required|missing.*argument.*name|positional.*named|命名参数|参数名.*缺失)/i,
		category: "命名参数遗漏",
		docPaths: ["manual/source_zh_cn/function/call_functions.md"],
		suggestion: "某些函数要求使用命名参数（name: value 语法）。检查函数声明确认参数是否需要命名。",
		fixDirective: "使用命名参数语法 func(paramName: value)，检查函数声明确认参数名",
		priority: 50,
	},
	{
		pattern: /(?:extend.*visibility|extend.*access|extend.*private|extend.*public|扩展.*可见性|extend.*scope)/i,
		category: "extend 可见性错误",
		docPaths: ["manual/source_zh_cn/extension/access_rules.md"],
		suggestion: "extend 中的方法可见性不能超过被扩展类型本身的可见性。跨包 extend 只能添加 public 方法。",
		fixDirective: "检查 extend 成员可见性不超过原类型；跨包 extend 只能添加 public 方法",
		priority: 55,
	},
	{
		pattern: /(?:heterogeneous.*array|mixed.*type.*array|array.*element.*type|数组.*混合.*类型|元素类型不一致)/i,
		category: "数组混合类型",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/expression.md"],
		suggestion: "仓颉数组要求所有元素同类型。混合类型需使用 enum 或 interface 统一。Array<Any> 不安全，避免使用。",
		fixDirective: "确保数组元素类型一致，或定义枚举/接口统一类型",
		priority: 45,
	},
	{
		pattern: /(?:expected.*expression|expression.*expected|expected.*type|type.*expected)/i,
		category: "缺少表达式或类型",
		docPaths: ["manual/source_zh_cn/basic_programming_concepts/expression.md"],
		suggestion: "缺少表达式或类型声明。检查赋值右侧、函数参数或返回类型是否完整。",
		fixDirective: "补全缺失的表达式或类型声明",
		priority: 20,
	},
	{
		pattern: /(?:abstract.*instantiate|cannot.*create.*abstract|抽象.*实例化)/i,
		category: "抽象类实例化",
		docPaths: ["manual/source_zh_cn/class_and_interface/class.md"],
		suggestion: "抽象类不能直接实例化。需要创建具体子类或使用工厂方法。",
		fixDirective: "创建具体子类代替直接实例化抽象类",
		priority: 45,
	},
	{
		pattern: /(?:expected.*\bUnit\b|return.*in.*Unit|Unit.*return|should.*return.*nothing)/i,
		category: "Unit 返回值错误",
		docPaths: ["manual/source_zh_cn/function/define_functions.md"],
		suggestion: "Unit 返回类型的函数不应有 return 表达式（或写 return 不带值）。如需返回值请修改返回类型声明。",
		fixDirective: "移除 return 表达式，或修改函数返回类型",
		priority: 30,
	},
]

const DEFAULT_PATTERN_PRIORITY = 0

export function patternPriority(p: CjcErrorPattern): number {
	return p.priority ?? DEFAULT_PATTERN_PRIORITY
}

const CJC_PATTERN_INDEX = new Map<CjcErrorPattern, number>()
for (let i = 0; i < CJC_ERROR_PATTERNS.length; i++) {
	CJC_PATTERN_INDEX.set(CJC_ERROR_PATTERNS[i], i)
}

const CJC_ERROR_PATTERNS_BY_PRIORITY_DESC = [...CJC_ERROR_PATTERNS].sort((a, b) => {
	const pa = patternPriority(a)
	const pb = patternPriority(b)
	if (pa !== pb) return pb - pa
	return (CJC_PATTERN_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) - (CJC_PATTERN_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
})

function pickBestSamePriority(best: CjcErrorPattern, p: CjcErrorPattern): CjcErrorPattern {
	if (patternPriority(p) > patternPriority(best)) return p
	if (patternPriority(p) < patternPriority(best)) return best
	const bi = CJC_PATTERN_INDEX.get(best) ?? Number.MAX_SAFE_INTEGER
	const pi = CJC_PATTERN_INDEX.get(p) ?? Number.MAX_SAFE_INTEGER
	return pi < bi ? p : best
}

/** Single best pattern for a message (highest priority, then earlier in {@link CJC_ERROR_PATTERNS}). */
export function matchCjcErrorPattern(text: string): CjcErrorPattern | null {
	for (const p of CJC_ERROR_PATTERNS_BY_PRIORITY_DESC) {
		if (p.pattern.test(text)) return p
	}
	return null
}

/** All matching patterns, one per category, highest priority per category. */
export function getMatchingCjcPatternsByCategory(text: string): CjcErrorPattern[] {
	const byCat = new Map<string, CjcErrorPattern>()
	for (const p of CJC_ERROR_PATTERNS) {
		if (!p.pattern.test(text)) continue
		const cur = byCat.get(p.category)
		if (!cur) {
			byCat.set(p.category, p)
			continue
		}
		byCat.set(p.category, pickBestSamePriority(cur, p))
	}
	// Remove categories subsumed by higher-priority patterns to avoid
	// redundant suggestions (e.g. "接口未实现（精确）" suppresses "接口未实现").
	const suppressed = new Set<string>()
	for (const [, p] of byCat) {
		for (const sub of p.subsumes ?? []) {
			suppressed.add(sub)
		}
	}
	for (const cat of suppressed) {
		byCat.delete(cat)
	}
	return [...byCat.values()].sort((a, b) => {
		const pa = patternPriority(a)
		const pb = patternPriority(b)
		if (pa !== pb) return pb - pa
		return (CJC_PATTERN_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) - (CJC_PATTERN_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
	})
}

/** Populated from each pattern's optional `diagnosticCodes` when the toolchain documents stable codes. */
export const CJC_DIAGNOSTIC_CODE_MAP = buildCjcDiagnosticCodeMap(CJC_ERROR_PATTERNS)

// ---------------------------------------------------------------------------
// Analysis API
// ---------------------------------------------------------------------------

const STD_PKG_RE = /\bstd\.\w+/g

/**
 * Analyze compile output and return structured error analysis results.
 * Matches error messages against known patterns and maps them to documentation.
 */
export function analyzeCompileOutput(
	output: string,
	errorLocations: Array<{ file: string; line: number; col: number }>,
	docsBase?: string,
): ErrorAnalysis[] {
	const results: ErrorAnalysis[] = []

	const stdPackagesInOutput = new Set<string>()
	let m: RegExpExecArray | null
	STD_PKG_RE.lastIndex = 0
	while ((m = STD_PKG_RE.exec(output)) !== null) {
		stdPackagesInOutput.add(m[0])
	}

	for (const pattern of getMatchingCjcPatternsByCategory(output)) {
		let relPaths = pattern.docPaths
		if (docsBase) {
			relPaths = relPaths.map((p) => path.join(docsBase, p).replace(/\\/g, "/"))
		}

		for (const stdPkg of stdPackagesInOutput) {
			for (const mapping of STDLIB_DOC_MAP) {
				if (stdPkg === mapping.prefix || stdPkg.startsWith(mapping.prefix + ".") && !relPaths.some((r) => mapping.docPaths.some((d) => r.includes(d)))) {
					const extra = docsBase
						? mapping.docPaths.map((d) => path.join(docsBase, d).replace(/\\/g, "/"))
						: mapping.docPaths
					relPaths = [...relPaths, ...extra]
				}
			}
		}

		const errorKeys = errorLocations.map((loc) => `${loc.file}:${loc.line}`)

		results.push({
			category: pattern.category,
			docHints: {
				relPaths,
				rationale: `编译错误类别「${pattern.category}」对应的文档路径`,
			},
			suggestion: pattern.suggestion,
			errorKeys,
		})
	}

	return results
}

/**
 * Get a specific fix directive string for an error message, suitable for AI consumption.
 */
const UNUSED_RE = /unused\s+(?:variable|import|parameter|function)/i
const REMINDER =
	" （切记：遇到模糊报错，务必要对其类型或发生错误的用法使用 grep_search 检索 manual/ 与 libs/ 内容查阅修正方案体系！）"

export function getErrorFixDirective(errorMessage: string): string {
	if (UNUSED_RE.test(errorMessage)) {
		return `移除未使用的变量/导入/参数${REMINDER}`
	}
	const matched = matchCjcErrorPattern(errorMessage)
	if (matched) {
		return `${matched.fixDirective ?? matched.suggestion}${REMINDER}`
	}
	return "深入报错根源，如果是没见过的编译错误，必须立刻调出 grep_search 前往 CangjieCorpus 语料库寻找相关错误的规范修复手段或 API 改动机制！然后再修代码！"
}

/**
 * Return a clean fix directive for a compiler error, suitable for recording in learned-fixes.
 * Unlike {@link getErrorFixDirective}, does NOT append the REMINDER suffix and returns null
 * when no specific pattern matches (callers should fall back to other heuristics).
 */
export function getFixDirectiveForLearning(errorMessage: string): string | null {
	if (UNUSED_RE.test(errorMessage)) {
		return "移除未使用的变量/导入/参数"
	}
	const matched = matchCjcErrorPattern(errorMessage)
	if (matched) {
		return matched.fixDirective ?? matched.suggestion
	}
	return null
}

/**
 * Normalize a raw compiler error snippet into a stable pattern key for deduplication.
 * Strips ANSI codes, file-path location prefixes, and collapses whitespace.
 * Prefixes with the matched error category when available.
 */
export function normalizeErrorPattern(errorSnippet: string): string {
	const s = errorSnippet
		// eslint-disable-next-line no-control-regex
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/==>\s+\S+:\d+:\d+:\s*/g, "")
		.replace(/\s+/g, " ")
		.trim()

	const matched = matchCjcErrorPattern(errorSnippet)
	if (matched) {
		return `[${matched.category}] ${s.slice(0, 120)}`
	}
	return s.slice(0, 200)
}

/**
 * Format analysis results into a human-readable summary for the output channel.
 */
export function formatAnalysisSummary(analyses: ErrorAnalysis[]): string {
	if (analyses.length === 0) return ""

	const lines = ["[ErrorAnalyzer] Structured error analysis:"]
	for (const a of analyses) {
		lines.push(`  [${a.category}] ${a.suggestion}`)
		if (a.docHints.relPaths.length > 0) {
			lines.push(`    docs: ${a.docHints.relPaths.slice(0, 3).join(", ")}`)
		}
	}
	return lines.join("\n")
}
