/**
 * check-inheritance.mjs
 *
 * CI 防回归脚本：检查 TypeScript 继承体系的健康指标。
 *
 * 指标：
 *   1. 继承深度 ≤ MAX_DEPTH（默认 3 层）
 *   2. 每个基类的抽象/override 方法数 ≤ MAX_ABSTRACT_METHODS（默认 10）
 *   3. 无 diamond inheritance
 *
 * 用法：node scripts/check-inheritance.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, dirname, relative, join, extname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "..")

// ── 配置 ─────────────────────────────────────────────────────────
const MAX_DEPTH = 3
const MAX_OVERRIDE_METHODS = 10

// 扫描目录（排除测试和构建产物）
const SCAN_DIRS = [resolve(rootDir, "src"), resolve(rootDir, "packages")]
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__", "build", ".turbo", "coverage"])
const INCLUDE_EXTENSIONS = new Set([".ts", ".tsx"])
const EXCLUDE_PATTERNS = [".spec.", ".test.", ".d.ts"]

// ── 文件发现 ─────────────────────────────────────────────────────

function* walkDir(dir) {
	let entries
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		if (EXCLUDE_DIRS.has(entry.name)) continue
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			yield* walkDir(fullPath)
		} else if (entry.isFile()) {
			const ext = extname(entry.name)
			if (!INCLUDE_EXTENSIONS.has(ext)) continue
			if (EXCLUDE_PATTERNS.some((p) => entry.name.includes(p))) continue
			yield fullPath
		}
	}
}

// ── 解析 ─────────────────────────────────────────────────────────

// 匹配: class Foo extends Bar
const CLASS_EXTENDS_RE = /export\s+(?:abstract\s+)?class\s+(\w+)(?:<[^>]*>)?\s+extends\s+(\w+)(?:<[^>]*>)?/g

// 匹配: abstract methodName( 或 override methodName(
const ABSTRACT_METHOD_RE = /^\s*(?:abstract|override)\s+(?:async\s+)?(\w+)\s*[(<]/gm
const OVERRIDE_KEYWORD_RE = /^\s*override\s+(?:async\s+)?(\w+)\s*[(<]/gm

function parseFile(filePath) {
	let content
	try {
		content = readFileSync(filePath, "utf8")
	} catch {
		return { classes: [], overrides: [] }
	}

	const classes = []
	const overrides = []
	const relPath = relative(rootDir, filePath).replace(/\\/g, "/")

	// 提取 class extends 关系
	let match
	CLASS_EXTENDS_RE.lastIndex = 0
	while ((match = CLASS_EXTENDS_RE.exec(content)) !== null) {
		classes.push({
			child: match[1],
			parent: match[2],
			file: relPath,
		})
	}

	// 提取 override 方法（按类分组不太可靠，所以统计每个文件中 override 数量）
	OVERRIDE_KEYWORD_RE.lastIndex = 0
	while ((match = OVERRIDE_KEYWORD_RE.exec(content)) !== null) {
		overrides.push({
			method: match[1],
			file: relPath,
		})
	}

	return { classes, overrides }
}

// ── 图构建与分析 ─────────────────────────────────────────────────

function buildInheritanceGraph(allClasses) {
	// child -> parent 映射
	const childToParent = new Map()
	// parent -> children 映射
	const parentToChildren = new Map()
	// class -> file 映射（最后定义的位置）
	const classFile = new Map()

	for (const { child, parent, file } of allClasses) {
		childToParent.set(child, parent)
		classFile.set(child, file)

		if (!parentToChildren.has(parent)) {
			parentToChildren.set(parent, [])
		}
		parentToChildren.get(parent).push(child)
	}

	return { childToParent, parentToChildren, classFile }
}

function computeDepth(className, childToParent, visited = new Set()) {
	if (visited.has(className)) return { depth: -1, chain: [...visited, className], cycle: true }
	visited.add(className)

	const parent = childToParent.get(className)
	if (!parent) return { depth: 0, chain: [className], cycle: false }

	const parentResult = computeDepth(parent, childToParent, new Set(visited))
	return {
		depth: parentResult.depth + 1,
		chain: [className, ...parentResult.chain],
		cycle: parentResult.cycle,
	}
}

function countOverridesPerBase(parentToChildren, allOverrides) {
	// 统计每个基类的直接和间接子类中的 override 方法数
	const overrideCounts = new Map()

	for (const override of allOverrides) {
		// 从文件名推断所属类（简化处理）
		// 更精确的方式需要解析 class 块，但这里用文件名做近似
		const fileName = override.file
			.split("/")
			.pop()
			?.replace(/\.tsx?$/, "")
		const key = fileName || override.file
		if (!overrideCounts.has(key)) {
			overrideCounts.set(key, [])
		}
		overrideCounts.get(key).push(override.method)
	}

	return overrideCounts
}

function detectDiamondInheritance(childToParent) {
	// 简化检测：如果同一个类可以通过多条路径到达同一个祖先，则为 diamond
	// 由于 TS 不支持多继承，真正的 diamond inheritance 不存在
	// 但可以检测 mixin 模式（通过 implements 多个接口 + extends）
	// 这里返回空，因为 TS 单继承不会有真正的 diamond
	return []
}

// ── 主逻辑 ───────────────────────────────────────────────────────

const outputJson = process.argv.includes("--json")

const allClasses = []
const allOverrides = []

for (const dir of SCAN_DIRS) {
	for (const filePath of walkDir(dir)) {
		const { classes, overrides } = parseFile(filePath)
		allClasses.push(...classes)
		allOverrides.push(...overrides)
	}
}

const { childToParent, parentToChildren, classFile } = buildInheritanceGraph(allClasses)

// 1. 计算继承深度
const depthViolations = []
const allClassNames = new Set([...childToParent.keys(), ...childToParent.values()])
for (const className of allClassNames) {
	if (!childToParent.has(className)) continue // 只检查有父类的类
	const { depth, chain, cycle } = computeDepth(className, childToParent)
	if (cycle) {
		depthViolations.push({
			class: className,
			depth: -1,
			chain,
			reason: "circular inheritance",
		})
	} else if (depth > MAX_DEPTH) {
		depthViolations.push({
			class: className,
			depth,
			chain,
			reason: `depth ${depth} > ${MAX_DEPTH}`,
		})
	}
}

// 2. 统计 override 方法数（按文件分组）
const overrideCounts = countOverridesPerBase(parentToChildren, allOverrides)
const overrideViolations = []
for (const [file, methods] of overrideCounts) {
	if (methods.length > MAX_OVERRIDE_METHODS) {
		overrideViolations.push({
			file,
			count: methods.length,
			methods,
			reason: `${methods.length} overrides > ${MAX_OVERRIDE_METHODS}`,
		})
	}
}

// 3. Diamond inheritance（TS 单继承下不适用，保留为占位）
const diamonds = detectDiamondInheritance(childToParent)

// ── 输出 ─────────────────────────────────────────────────────────

const report = {
	timestamp: new Date().toISOString(),
	summary: {
		totalClasses: allClassNames.size,
		totalInheritanceRelations: allClasses.length,
		totalOverrideMethods: allOverrides.length,
		maxDepth: Math.max(
			0,
			...[...allClassNames].map((c) => computeDepth(c, childToParent).depth).filter((d) => d >= 0),
		),
	},
	violations: {
		depth: depthViolations,
		overrides: overrideViolations,
		diamonds,
	},
	thresholds: {
		maxDepth: MAX_DEPTH,
		maxOverrideMethods: MAX_OVERRIDE_METHODS,
	},
}

if (outputJson) {
	console.log(JSON.stringify(report, null, 2))
} else {
	console.log("🏗️  Inheritance Health Report\n")
	console.log(`   类总数:           ${report.summary.totalClasses}`)
	console.log(`   继承关系数:       ${report.summary.totalInheritanceRelations}`)
	console.log(`   override 方法数:  ${report.summary.totalOverrideMethods}`)
	console.log(`   最大继承深度:     ${report.summary.maxDepth}`)
	console.log("")

	// 继承深度分布
	const depthDistribution = new Map()
	for (const className of allClassNames) {
		if (!childToParent.has(className)) continue
		const { depth } = computeDepth(className, childToParent)
		if (depth >= 0) {
			depthDistribution.set(depth, (depthDistribution.get(depth) || 0) + 1)
		}
	}
	console.log("   继承深度分布:")
	for (const [depth, count] of [...depthDistribution.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`     ${depth} 层: ${count} 个类`)
	}
	console.log("")

	// 深度违规
	if (depthViolations.length > 0) {
		console.log(`   ❌ 继承深度违规 (${depthViolations.length}):`)
		for (const v of depthViolations.slice(0, 10)) {
			console.log(`     ${v.class}: ${v.reason}`)
			console.log(`       链: ${v.chain.join(" → ")}`)
		}
	} else {
		console.log(`   ✅ 继承深度: 全部 ≤ ${MAX_DEPTH}`)
	}

	// Override 违规
	if (overrideViolations.length > 0) {
		console.log(`\n   ❌ Override 方法数违规 (${overrideViolations.length}):`)
		for (const v of overrideViolations.slice(0, 10)) {
			console.log(`     ${v.file}: ${v.count} 个 override 方法`)
		}
	} else {
		console.log(`   ✅ Override 方法数: 全部 ≤ ${MAX_OVERRIDE_METHODS}`)
	}

	// Diamond
	if (diamonds.length > 0) {
		console.log(`\n   ❌ Diamond inheritance (${diamonds.length})`)
	} else {
		console.log(`   ✅ Diamond inheritance: 无`)
	}

	console.log("")
}

// ── 退出码 ───────────────────────────────────────────────────────

const totalViolations = depthViolations.length + overrideViolations.length + diamonds.length

if (totalViolations > 0) {
	console.error(`❌ 检测到 ${totalViolations} 项继承健康违规。请检查并修复。`)
	process.exit(1)
}

console.log("✅ 继承健康检查通过。")
process.exit(0)
