/**
 * check-circular.mjs
 *
 * CI 防回归脚本：检测关键模块间的循环依赖。
 * 监控两条历史循环路径：
 *   1. src/core/webview/ ↔ src/core/task/
 *   2. src/services/mcp/ ↔ src/core/webview/
 *
 * 使用 madge 进行静态依赖分析。
 * 如果发现任何循环依赖，以非零退出码退出。
 */

import { createRequire } from "node:module"
import { resolve, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "..")
const srcDir = resolve(rootDir, "src")

// 定义需要监控的模块对（不允许互相导入）
const MONITORED_PAIRS = [
	{
		name: "webview ↔ task",
		moduleA: { label: "webview", dir: resolve(srcDir, "core/webview") },
		moduleB: { label: "task", dir: resolve(srcDir, "core/task") },
	},
	{
		name: "mcp ↔ webview",
		moduleA: { label: "mcp", dir: resolve(srcDir, "services/mcp") },
		moduleB: { label: "webview", dir: resolve(srcDir, "core/webview") },
	},
]

async function getCircularDependencies(directory) {
	const require = createRequire(import.meta.url)
	const madge = require("madge")

	const result = await madge(directory, {
		extensions: ["ts", "tsx", "js", "jsx"],
		excludeRegExp: ["node_modules", "__tests__", "__mocks__", ".spec.", ".test.", "dist"],
		tsConfig: resolve(srcDir, "tsconfig.json"),
	})

	return result.circular()
}

/**
 * 检查一组循环依赖是否涉及两个指定模块之间的交叉引用。
 * 返回涉及交叉引用的循环路径列表。
 */
function findCrossModuleCirculars(circulars, moduleA, moduleB) {
	const violations = []
	const relA = (p) => relative(srcDir, resolve(srcDir, p)).replace(/\\/g, "/")
	const isModuleA = (p) => relA(p).startsWith(relative(srcDir, moduleA.dir).replace(/\\/g, "/"))
	const isModuleB = (p) => relA(p).startsWith(relative(srcDir, moduleB.dir).replace(/\\/g, "/"))

	for (const cycle of circulars) {
		const hasA = cycle.some(isModuleA)
		const hasB = cycle.some(isModuleB)
		if (hasA && hasB) {
			violations.push(cycle.map((p) => relA(p)))
		}
	}

	return violations
}

async function main() {
	console.log("🔍 循环依赖检测\n")
	console.log(`   根目录: ${rootDir}`)
	console.log(`   源码目录: ${srcDir}\n`)

	// 对整个 src 目录做一次完整的依赖分析
	console.log("   正在分析 src/ 依赖图...")
	const allCirculars = await getCircularDependencies(srcDir)

	if (allCirculars.length === 0) {
		console.log("\n✅ 未发现任何循环依赖。\n")
		process.exit(0)
	}

	console.log(`   发现 ${allCirculars.length} 条循环依赖路径\n`)

	let totalViolations = 0

	for (const pair of MONITORED_PAIRS) {
		const violations = findCrossModuleCirculars(allCirculars, pair.moduleA, pair.moduleB)

		if (violations.length === 0) {
			console.log(`✅ ${pair.name}: 无交叉循环依赖`)
		} else {
			totalViolations += violations.length
			console.log(`❌ ${pair.name}: 发现 ${violations.length} 条交叉循环依赖！`)
			for (const cycle of violations) {
				console.log(`   ${cycle.join(" → ")} → ${cycle[0]}`)
			}
		}
	}

	// 同时报告所有其他循环依赖（不阻塞，仅信息性输出）
	const monitoredModules = new Set(MONITORED_PAIRS.flatMap((p) => [p.moduleA.dir, p.moduleB.dir]))
	const otherCirculars = allCirculars.filter((cycle) => {
		return !cycle.some((file) => {
			const rel = relative(srcDir, resolve(srcDir, file)).replace(/\\/g, "/")
			return [...monitoredModules].some((dir) => rel.startsWith(relative(srcDir, dir).replace(/\\/g, "/")))
		})
	})

	if (otherCirculars.length > 0) {
		console.log(`\n⚠️  其他循环依赖（${otherCirculars.length} 条，仅信息性）:`)
		for (const cycle of otherCirculars.slice(0, 10)) {
			const short = cycle.map((p) => relative(srcDir, resolve(srcDir, p)).replace(/\\/g, "/"))
			console.log(`   ${short.join(" → ")}`)
		}
		if (otherCirculars.length > 10) {
			console.log(`   ... 还有 ${otherCirculars.length - 10} 条`)
		}
	}

	console.log("")

	if (totalViolations > 0) {
		console.log(`❌ 检测到 ${totalViolations} 条关键模块间循环依赖。请修复后再提交。`)
		process.exit(1)
	} else {
		console.log("✅ 所有关键模块间无循环依赖。")
		process.exit(0)
	}
}

main().catch((err) => {
	console.error("❌ 检测脚本执行失败:", err.message)
	process.exit(2)
})
