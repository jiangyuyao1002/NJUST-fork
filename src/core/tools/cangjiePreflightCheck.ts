import { STDLIB_CRITICAL_SIGNATURES, parseCjpmToml } from "../prompts/sections/cangjie-context"

/**
 * Pre-built set of std.* module keys that have detailed parameter-level signatures
 * in STDLIB_CRITICAL_SIGNATURES. Modules in this set are exempt from search gate warnings.
 */
export const CRITICAL_SIGNATURE_MODULES: ReadonlySet<string> = new Set(Object.keys(STDLIB_CRITICAL_SIGNATURES))

export interface PreflightResult {
	pass: boolean
	warnings: string[]
	errors: string[]
}

/**
 * Known std.* top-level modules in Cangjie stdlib.
 * Used for import path validation and search gate filtering.
 */
export const KNOWN_STD_MODULES = new Set([
	"std.collection",
	"std.io",
	"std.fs",
	"std.net",
	"std.sync",
	"std.time",
	"std.math",
	"std.regex",
	"std.console",
	"std.convert",
	"std.unittest",
	"std.objectpool",
	"std.unicode",
	"std.log",
	"std.ffi",
	"std.format",
	"std.random",
	"std.process",
	"std.env",
	"std.reflect",
	"std.sort",
	"std.binary",
	"std.ast",
	"std.crypto",
	"std.database",
	"std.core",
	"std.deriving",
	"std.overflow",
	"std.os",
	"std.socket",
	"std.compress",
])

/**
 * Basic modules that are too common / trivial to trigger search gate warnings.
 */
export const SEARCH_GATE_EXEMPT_MODULES = new Set(["std.core", "std.console"])

/**
 * Infer the expected `package` declaration from a file's relative path within a cjpm project.
 * For `src/foo/bar/baz.cj`, the expected package is `foo.bar` (relative to src/).
 * For `src/main.cj` or `src/lib.cj`, the expected package is `rootPackageName` (from cjpm.toml).
 */
export function inferPackageFromPath(relPath: string, _cwd: string, rootPackageName?: string): string | null {
	const normalized = relPath.replace(/\\/g, "/")
	const srcIdx = normalized.indexOf("src/")
	if (srcIdx < 0) return null

	const afterSrc = normalized.slice(srcIdx + 4)
	const parts = afterSrc.split("/")
	if (parts.length <= 1) {
		return rootPackageName ?? null
	}
	// Remove the filename, keep directory path as dotted package
	return parts.slice(0, -1).join(".")
}

/**
 * Extract std.* top-level module names from import statements in Cangjie source code.
 */
export function extractStdImports(content: string): string[] {
	const result = new Set<string>()
	const importRe = /^\s*import\s+([\w.*]+)/gm
	let m: RegExpExecArray | null
	while ((m = importRe.exec(content)) !== null) {
		const imp = m[1]!
		if (imp.startsWith("std.")) {
			const parts = imp.split(".")
			if (parts.length >= 2) {
				result.add(`${parts[0]}.${parts[1]}`)
			}
		}
	}
	return [...result]
}

/**
 * Lightweight pre-write checks for `.cj` files. All checks are O(1) regex-based
 * (no compiler invocation). Errors block the write; warnings are appended to tool_result.
 * Note: All error/warning strings below are agent-facing (embedded in tool_result sent to the AI),
 * intentionally kept in Chinese as the Cangjie LLM responds better to Chinese technical feedback.
 */
export function cangjiePreflightCheck(
	content: string,
	targetRelPath: string,
	cwd: string,
	rootPackageName?: string,
): PreflightResult {
	const warnings: string[] = []
	const errors: string[] = []

	// 1. package declaration vs target path consistency
	const pkgMatch = content.match(/^\s*package\s+([\w.]+)/m)
	if (pkgMatch) {
		const expected = inferPackageFromPath(targetRelPath, cwd, rootPackageName)
		if (expected && pkgMatch[1] !== expected) {
			errors.push(
				`package 声明 "${pkgMatch[1]}" 与目标路径推断的 "${expected}" 不一致。` +
					`仓颉要求 package 声明与 src/ 下目录结构严格对应。`,
			)
		}
	}

	// 2. main() signature validation
	const mainMatch = content.match(/\bmain\s*\(([^)]*)\)\s*(?::\s*(\w+))?/)
	if (mainMatch) {
		const returnType = mainMatch[2]
		if (returnType && returnType !== "Int64") {
			errors.push(`main() 返回类型必须为 Int64，当前为 "${returnType}"。`)
		}
		if (!returnType) {
			warnings.push(`main() 缺少显式返回类型声明，建议写为 main(): Int64`)
		}
	}

	// 3. struct self-reference check (value types cannot be recursive)
	const structDefs = [...content.matchAll(/\bstruct\s+(\w+)\b/g)]
	for (const sm of structDefs) {
		const name = sm[1]
		const bodyRegex = new RegExp(
			`struct\\s+${name}\\s*(?:<[^>]*>)?\\s*(?:<:[^{]*)?\\{[^}]*\\b(?:let|var)\\s+\\w+\\s*:\\s*${name}\\b(?!\\?)`,
			"s",
		)
		if (bodyRegex.test(content)) {
			errors.push(`struct ${name} 不能直接自引用（值类型无限递归）。改用 class 或 ?${name}（Option）包装。`)
		}
	}

	// 4. import path basic validation
	const imports = [...content.matchAll(/^\s*import\s+([\w.*]+)/gm)]
	for (const imp of imports) {
		const importPath = imp[1]!
		if (importPath.startsWith("std.")) {
			const topModule = importPath.split(".").slice(0, 2).join(".")
			if (!KNOWN_STD_MODULES.has(topModule)) {
				warnings.push(`import "${importPath}" 中的标准库模块 "${topModule}" 未在已知列表中，请确认拼写。`)
			}
		}
	}

	return { pass: errors.length === 0, warnings, errors }
}

/**
 * Build a search gate warning for .cj files that use std.* modules
 * not previously searched via search_files in the current session.
 * Note: The returned warning is agent-facing (embedded in tool_result sent to the AI),
 * intentionally kept in Chinese.
 */
export function buildSearchGateWarning(
	content: string,
	searchHistory: ReadonlySet<string>,
	criticalSignatureModules: ReadonlySet<string>,
): string | null {
	const usedModules = extractStdImports(content)
	const unsearched = usedModules.filter(
		(m) => !searchHistory.has(m) && !criticalSignatureModules.has(m) && !SEARCH_GATE_EXEMPT_MODULES.has(m),
	)

	if (unsearched.length === 0) return null

	return (
		`\n\n<cangjie_search_gate>\n` +
		`警告：代码使用了以下标准库模块但本轮未通过 search_files 查询过其 API 签名：\n` +
		unsearched.map((m) => `- ${m}`).join("\n") +
		`\n` +
		`建议在下次修改前用 search_files(path=CangjieCorpus路径, semantic_query="...") 确认 API 签名，避免参数类型或方法名错误。\n` +
		`</cangjie_search_gate>`
	)
}

/**
 * Extract std module names mentioned in a search_files query
 * (from regex pattern or semantic_query text).
 */
export function extractStdModulesFromQuery(regex?: string, semanticQuery?: string): string[] {
	const result = new Set<string>()
	const combined = `${regex ?? ""} ${semanticQuery ?? ""}`
	const re = /\bstd\.(\w+)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(combined)) !== null) {
		result.add(`std.${m[1]}`)
	}
	return [...result]
}

/**
 * Resolve the root package name from cjpm.toml. Returns undefined on failure
 * or if not a cjpm project. Result is cheap to call (parseCjpmToml uses mtime-based cache).
 */
export async function resolveRootPackageName(cwd: string): Promise<string | undefined> {
	try {
		const info = await parseCjpmToml(cwd)
		return info?.name || undefined
	} catch {
		return undefined
	}
}
