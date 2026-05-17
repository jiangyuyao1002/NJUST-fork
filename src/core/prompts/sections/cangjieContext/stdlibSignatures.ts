/** Pre-baked one-line API hints for std roots — avoids extra corpus hits for common imports. */
export const STDLIB_API_SIGNATURE_HINTS: Record<string, string> = {
	"std.collection":
		"ArrayList<T>, HashMap<K,V>, HashSet<T>, TreeMap<K,V>; HashMap 常要求 K <: Hashable & Equatable<K>，TreeMap 常要求 K <: Comparable<K>",
	"std.io": "InputStream, OutputStream, 读写与缓冲",
	"std.fs": "路径与文件系统遍历",
	"std.net": "TCP/UDP、HTTP、Socket",
	"std.sync": "Mutex, ReentrantMutex, Atomic*, synchronized",
	"std.time": "日期时间与 Duration",
	"std.math": "常用数学函数与常量",
	"std.regex": "Regex 构造与匹配",
	"std.console": "println, readLine",
	"std.convert": "ToString 与各类型解析",
	"std.unittest": "@Test, @TestCase, @Assert",
	"std.objectpool": "对象池借还与复用策略",
	"std.unicode": "Unicode 字符分类、规范化与编码处理",
	"std.log": "日志记录器、级别与格式化输出",
	"std.ffi": "foreign/@C 声明、跨语言类型映射",
	"std.format": "字符串与数值格式化输出",
	"std.random": "随机数与采样",
	"std.process": "子进程与参数",
	"std.env": "环境变量读写",
	"std.reflect": "反射与 Annotation",
	"std.sort": "排序算法",
	"std.binary": "字节与Endian",
	"std.ast": "宏与 AST 构造",
	"std.crypto": "摘要与对称算法入口",
	"std.database": "SQL 访问抽象",
	"std.core": "自动导入核心类型",
	"std.deriving": "派生宏（如 Equatable）",
	"std.overflow": "防溢出算术",
}

/**
 * Parameter-level API signatures for the top-20 highest-misuse stdlib APIs.
 * These are injected when the corresponding import is detected.
 * Modules covered here are also exempt from search gate warnings.
 */
export const STDLIB_CRITICAL_SIGNATURES: Record<string, string> = {
	"std.collection": [
		"class ArrayList<T> { init(); init(capacity: Int64); func append(T): Unit; func get(Int64): T; func set(Int64, T): Unit; prop size: Int64; func remove(Int64): T; func iterator(): Iterator<T> }",
		"class HashMap<K, V> where K <: Hashable & Equatable<K> { init(); func put(K, V): Unit; func get(K): ?V; func contains(K): Bool; func remove(K): ?V; prop size: Int64 }",
		"class HashSet<T> where T <: Hashable & Equatable<T> { init(); func put(T): Bool; func contains(T): Bool; func remove(T): Bool; prop size: Int64 }",
		"class TreeMap<K, V> where K <: Comparable<K> { init(); func put(K, V): Unit; func get(K): ?V; prop size: Int64 }",
	].join("\n"),
	"std.io": [
		"class InputStream { func read(Array<Byte>): Int64; func close(): Unit }",
		"class OutputStream { func write(Array<Byte>): Unit; func flush(): Unit; func close(): Unit }",
		"class BufferedReader { init(InputStream); func readLine(): ?String; func close(): Unit }",
		"class StringReader <: InputStream { init(String) }",
		"class StringWriter <: OutputStream { init(); func toString(): String }",
	].join("\n"),
	"std.fs": [
		"class File { static func readString(String): String; static func writeString(String, String): Unit; static func exists(String): Bool; static func delete(String): Unit }",
		"class Path { init(String); func resolve(String): Path; func parent(): ?Path; prop fileName: String; func toString(): String }",
		"class Directory { static func create(String): Unit; static func listEntries(String): Array<String> }",
	].join("\n"),
	"std.sync": [
		"class Mutex<T> { init(T); func lock(): MutexGuard<T>; func tryLock(): ?MutexGuard<T> }",
		"class ReentrantMutex { init(); func lock(): Unit; func unlock(): Unit; func tryLock(): Bool }",
		"class AtomicInt64 { init(Int64); func load(): Int64; func store(Int64): Unit; func fetchAdd(Int64): Int64 }",
		"class AtomicBool { init(Bool); func load(): Bool; func store(Bool): Unit }",
		"func synchronized<T>(lock: ReentrantMutex, body: () -> T): T",
	].join("\n"),
	"std.regex": [
		"class Regex { init(String); func matches(String): Bool; func find(String): ?MatchResult; func findAll(String): Array<MatchResult>; func replace(String, String): String }",
		"class MatchResult { prop value: String; prop start: Int64; prop end: Int64; func group(Int64): ?String }",
	].join("\n"),
	"std.console": "func println(String): Unit\nfunc print(String): Unit\nfunc readLine(): String",
	"std.convert": [
		"interface ToString { func toString(): String }",
		"func Int64.parse(String): ?Int64",
		"func Float64.parse(String): ?Float64",
		"func Bool.parse(String): ?Bool",
	].join("\n"),
	"std.unittest": [
		"@Test — 标记测试类",
		"@TestCase — 标记测试方法",
		"@Assert(condition) — 断言宏",
		"@Expect(condition) — 非致命断言",
		"@Timeout(ms: Int64) — 超时限制",
	].join("\n"),
	"std.format": [
		"func format(fmt: String, args: Array<ToString>): String",
		"字符串插值: \"value = ${expr}\" — expr 须实现 ToString",
	].join("\n"),
	"std.random": [
		"class Random { init(); init(seed: Int64); func nextInt64(): Int64; func nextInt64(bound: Int64): Int64; func nextFloat64(): Float64; func nextBool(): Bool }",
	].join("\n"),
	"std.math": [
		"func abs(Int64): Int64; func abs(Float64): Float64",
		"func min<T>(T, T): T where T <: Comparable<T>; func max<T>(T, T): T where T <: Comparable<T>",
		"func sqrt(Float64): Float64; func pow(Float64, Float64): Float64",
		"const PI: Float64; const E: Float64",
	].join("\n"),
	"std.time": [
		"class DateTime { static func now(): DateTime; func toString(): String; func toTimestamp(): Int64 }",
		"class Duration { static func fromSeconds(Int64): Duration; static func fromMillis(Int64): Duration; prop totalMillis: Int64 }",
	].join("\n"),
	"std.process": [
		"class Process { static func run(command: String, args: Array<String>): ProcessResult }",
		"class ProcessResult { prop exitCode: Int64; prop stdout: String; prop stderr: String }",
	].join("\n"),
	"std.env": [
		"func getEnv(String): ?String",
		"func setEnv(String, String): Unit",
		"func currentDir(): String",
	].join("\n"),
	"std.log": [
		"class Logger { static func getLogger(name: String): Logger; func info(String): Unit; func warn(String): Unit; func error(String): Unit; func debug(String): Unit }",
		"enum LogLevel { case DEBUG | INFO | WARN | ERROR }",
	].join("\n"),
}

