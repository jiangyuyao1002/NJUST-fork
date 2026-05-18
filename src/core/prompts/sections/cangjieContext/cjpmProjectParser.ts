import * as fs from "fs"
import * as path from "path"
import { parse as parseToml } from "smol-toml"

import { getCjpmTreeSummaryForPrompt } from "../../../../services/cangjie-lsp/cjpmTreeForPrompt"
import { CangjieSymbolIndex } from "../../../../services/cangjie-lsp/CangjieSymbolIndex"
import { logger } from "../../../../shared/logger"
import { simpleHash } from "./budget"

const PACKAGE_DECL_REGEX = /^\s*package\s+([\w.]+)\s*$/m

export interface CjpmProjectInfo {
	name: string
	version: string
	outputType: string
	isWorkspace: boolean
	members?: Array<{
		name: string
		path: string
		outputType: string
		dependencies?: Record<string, { path?: string; git?: string; tag?: string; branch?: string }>
		dependencyDisplay?: string[]
	}>
	dependencies?: Record<string, { path?: string; git?: string; tag?: string; branch?: string }>
	srcDir: string
}

export type WorkspaceMember = NonNullable<CjpmProjectInfo["members"]>[number]

export interface PackageNode {
	packageName: string
	dirPath: string
	sourceFiles: string[]
	testFiles: string[]
	hasMain: boolean
	children: PackageNode[]
}

const MAX_SCAN_DEPTH = 5
const MAX_SCAN_FILES = 500
const MAX_WORKSPACE_MEMBERS = 20

const PROJECT_OVERVIEW_CACHE_TTL_MS = 60_000
type CjpmTomlMetaCacheEntry = { mtimeMs: number; value: { info: CjpmProjectInfo | null; cjpmRawHash: string }; time: number }
const cjpmTomlMetaCache = new Map<string, CjpmTomlMetaCacheEntry>()

export async function verifyPackageDeclarations(
	root: PackageNode,
	cwd: string,
	srcDir: string,
): Promise<string | null> {
	const mismatches: string[] = []
	const MAX_CHECKS = 50
	let checked = 0
	const symbolIndex = CangjieSymbolIndex.getInstance()

	async function walk(node: PackageNode): Promise<void> {
		if (checked >= MAX_CHECKS) return

		for (const fileName of node.sourceFiles) {
			if (checked >= MAX_CHECKS) return
			checked++

			const filePath = path.join(cwd, node.dirPath, fileName)
			const expectedPkg = node.packageName
			let declaredPkg: string | null = null

			// Prefer SymbolIndex (no file I/O) over fs.readFileSync
			if (symbolIndex) {
				const syms = symbolIndex.getSymbolsByFile(filePath)
				const pkgSym = syms.find((s) => s.kind === "package")
				if (pkgSym) declaredPkg = pkgSym.name
			}

			// Fallback: read from disk (SymbolIndex may not include package entries)
			if (declaredPkg === null) {
				try {
					const content = await fs.promises.readFile(filePath, "utf-8")
					const match = content.match(PACKAGE_DECL_REGEX)
					declaredPkg = match ? (match[1] ?? null) : null
				} catch {
					continue
				}
			}

			if (declaredPkg && declaredPkg !== expectedPkg) {
				const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
				mismatches.push(
					`- ${relPath}: 声明 \`package ${declaredPkg}\`，但目录推导应为 \`package ${expectedPkg}\``,
				)
			} else if (!declaredPkg && node.packageName.includes(".")) {
				const relPath = path.relative(cwd, filePath).replace(/\\/g, "/")
				mismatches.push(
					`- ${relPath}: **缺少 package 声明**，应声明 \`package ${expectedPkg}\``,
				)
			}
		}

		for (const child of node.children) {
			await walk(child)
		}
	}

	await walk(root)

	if (mismatches.length === 0) return null

	return (
		`## ⚠ 包声明不一致\n\n` +
		`以下文件的 \`package\` 声明与目录结构不匹配，**生成代码时请使用正确的包名**：\n\n` +
		mismatches.join("\n") +
		`\n\n规则: 文件所在目录相对于 ${srcDir}/ 的路径决定包名（如 ${srcDir}/network/http/ → package <root>.network.http）`
	)
}

// ---------------------------------------------------------------------------
// Workspace cross-module symbol summary
// ---------------------------------------------------------------------------

/**
 * For workspace projects, generate a summary of public symbols in each
 * member module so the AI knows what's available across modules.
 */
export async function buildWorkspaceSymbolSummary(
	info: CjpmProjectInfo,
	cwd: string,
): Promise<string | null> {
	if (!info.isWorkspace || !info.members || info.members.length === 0) return null

	const symbolIndex = CangjieSymbolIndex.getInstance()
	if (!symbolIndex || symbolIndex.symbolCount === 0) return null

	const MAX_SYMBOLS_PER_MODULE = 20
	const moduleSections: string[] = []

	for (const member of info.members) {
		const memberSrcDir = path.join(cwd, member.path, "src")
		try {
			await fs.promises.access(memberSrcDir)
		} catch {
			continue
		}

		const symbols = symbolIndex.getSymbolsByDirectory(memberSrcDir)
		if (symbols.length === 0) continue

		const topLevel = symbols
			.filter((s) => ["class", "struct", "interface", "enum", "func", "type"].includes(s.kind))
			.slice(0, MAX_SYMBOLS_PER_MODULE)

		if (topLevel.length === 0) continue

		const lines = topLevel.map((s) => {
			const vis = s.visibility && s.visibility !== "internal" ? `${s.visibility} ` : ""
			const tp = s.typeParams ? `${s.typeParams} ` : ""
			const sig = s.signature ? `: \`${s.signature}\`` : ""
			return `  - ${vis}${s.kind} ${tp}**${s.name}**${sig}`
		})

		const suffix = symbols.length > MAX_SYMBOLS_PER_MODULE
			? `\n  - _…共 ${symbols.length} 个符号_`
			: ""

		moduleSections.push(`- **${member.name}** (${member.outputType}):\n${lines.join("\n")}${suffix}`)
	}

	if (moduleSections.length === 0) return null

	return (
		`## 工作区各模块公共符号\n\n` +
		`以下是各模块的主要类型和函数定义，跨模块引用时需确保目标符号为 public 并在 cjpm.toml 中声明依赖：\n\n` +
		moduleSections.join("\n\n")
	)
}

function splitTomlSections(content: string): Map<string, string> {
	const sections = new Map<string, string>()
	const lines = content.split("\n")
	let currentSection = ""
	let currentLines: string[] = []

	for (const line of lines) {
		const match = line.match(/^\s*\[([^\]]+)\]\s*$/)
		if (match) {
			if (currentSection) {
				sections.set(currentSection, currentLines.join("\n"))
			}
			currentSection = match[1]!.trim()
			currentLines = []
		} else {
			currentLines.push(line)
		}
	}

	if (currentSection) {
		sections.set(currentSection, currentLines.join("\n"))
	}

	return sections
}

function extractTomlString(section: string, key: string): string | undefined {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const re = new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"`, "m")
	const match = section.match(re)
	return match ? match[1] : undefined
}

function extractTomlArray(section: string, key: string): string[] {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const re = new RegExp(`^\\s*${escaped}\\s*=\\s*\\[([^\\]]*)\\]`, "ms")
	const match = section.match(re)
	if (!match) return []
	return match[1]!.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) || []
}

function extractTomlInlineTables(section: string): Record<string, Record<string, string>> {
	const result: Record<string, Record<string, string>> = {}
	const re = /^\s*(\S+)\s*=\s*\{([^}]*)\}\s*$/gm
	let match
	while ((match = re.exec(section)) !== null) {
		const key = match[1]!.trim()
		const tableContent = match[2]!
		const table: Record<string, string> = {}
		const kvRe = /([\w][\w-]*)\s*=\s*"([^"]*)"/g
		let kvMatch
		while ((kvMatch = kvRe.exec(tableContent)) !== null) {
			table[kvMatch[1]!] = kvMatch[2]!
		}
		result[key] = table
	}
	return result
}

function parseSingleModuleProject(sections: Map<string, string>): CjpmProjectInfo | null {
	const pkg = sections.get("package")
	if (!pkg) return null

	const name = extractTomlString(pkg, "name") || ""
	const version = extractTomlString(pkg, "version") || ""
	const outputType = extractTomlString(pkg, "output-type") || "executable"
	const srcDir = extractTomlString(pkg, "src-dir") || "src"

	let dependencies: CjpmProjectInfo["dependencies"]
	const deps = sections.get("dependencies")
	if (deps) {
		const tables = extractTomlInlineTables(deps)
		if (Object.keys(tables).length > 0) {
			dependencies = {}
			for (const [depName, t] of Object.entries(tables)) {
				dependencies[depName] = { path: t["path"], git: t["git"], tag: t["tag"], branch: t["branch"] }
			}
		}
	}

	return { name, version, outputType, isWorkspace: false, srcDir, dependencies }
}

function tomStr(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== "object") return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === "string" ? v : undefined
}

function tomDepsFromObject(tbl: unknown): CjpmProjectInfo["dependencies"] | undefined {
	if (!tbl || typeof tbl !== "object" || Array.isArray(tbl)) return undefined
	const out: NonNullable<CjpmProjectInfo["dependencies"]> = {}
	for (const [depName, val] of Object.entries(tbl as Record<string, unknown>)) {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const t = val as Record<string, unknown>
			out[depName] = {
				path: typeof t.path === "string" ? t.path : undefined,
				git: typeof t.git === "string" ? t.git : undefined,
				tag: typeof t.tag === "string" ? t.tag : undefined,
				branch: typeof t.branch === "string" ? t.branch : undefined,
			}
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function buildDependencyDisplay(
	deps: CjpmProjectInfo["dependencies"] | undefined,
): string[] | undefined {
	if (!deps || Object.keys(deps).length === 0) return undefined
	const rows = Object.entries(deps).map(([d, t]) => {
		if (t.path) return `${d}(path:${t.path})`
		if (t.git) return `${d}(git)`
		if (t.tag) return `${d}(tag:${t.tag})`
		if (t.branch) return `${d}(branch:${t.branch})`
		return d
	})
	return rows.length > 0 ? rows : undefined
}

async function parseMemberCjpmIntoWorkspaceMember(memberRoot: string, pathRel: string): Promise<WorkspaceMember | null> {
	const memberToml = path.join(memberRoot, "cjpm.toml")
	let content: string
	try {
		content = await fs.promises.readFile(memberToml, "utf-8")
	} catch {
		return null
	}
	try {
		const root = parseToml(content) as Record<string, unknown>
		const pkg = root.package
		if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
			const memberDeps = tomDepsFromObject(root.dependencies)
			return {
				name: tomStr(pkg, "name") || path.basename(pathRel),
				path: pathRel,
				outputType: tomStr(pkg, "output-type") || "static",
				dependencies: memberDeps,
				dependencyDisplay: buildDependencyDisplay(memberDeps),
			}
		}
	} catch {
		/* member smol-toml failed */
	}
	try {
		const ms = splitTomlSections(content)
		const pkg = ms.get("package")
		if (!pkg) return null
		let memberDeps: WorkspaceMember["dependencies"]
		const depSec = ms.get("dependencies")
		if (depSec) {
			const tables = extractTomlInlineTables(depSec)
			if (Object.keys(tables).length > 0) {
				memberDeps = {}
				for (const [depName, t] of Object.entries(tables)) {
					memberDeps[depName] = { path: t["path"], git: t["git"], tag: t["tag"], branch: t["branch"] }
				}
			}
		}
		return {
			name: extractTomlString(pkg, "name") || path.basename(pathRel),
			path: pathRel,
			outputType: extractTomlString(pkg, "output-type") || "static",
			dependencies: memberDeps,
			dependencyDisplay: buildDependencyDisplay(memberDeps),
		}
	} catch {
		return null
	}
}

async function projectInfoFromParsedTomlRoot(root: Record<string, unknown>, cwd: string): Promise<CjpmProjectInfo | null> {
	const ws = root.workspace
	if (ws && typeof ws === "object" && !Array.isArray(ws)) {
		const membersRaw = (ws as Record<string, unknown>).members
		const memberPaths = Array.isArray(membersRaw)
			? membersRaw.filter((x): x is string => typeof x === "string")
			: []
		const slice = memberPaths.slice(0, MAX_WORKSPACE_MEMBERS)
		const resolved = await Promise.all(slice.map((mp) => parseMemberCjpmIntoWorkspaceMember(path.join(cwd, mp), mp)))
		const members = resolved.filter((m): m is WorkspaceMember => m != null)
		const dependencies = tomDepsFromObject(root.dependencies)
		return { name: "", version: "", outputType: "", isWorkspace: true, members, dependencies, srcDir: "src" }
	}
	const pkg = root.package
	if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
		const name = tomStr(pkg, "name") || ""
		const version = tomStr(pkg, "version") || ""
		const outputType = tomStr(pkg, "output-type") || "executable"
		const srcDir = tomStr(pkg, "src-dir") || "src"
		const dependencies = tomDepsFromObject(root.dependencies)
		return { name, version, outputType, isWorkspace: false, srcDir, dependencies }
	}
	return null
}

async function parseWorkspaceProjectRegexAsync(sections: Map<string, string>, cwd: string): Promise<CjpmProjectInfo | null> {
	const ws = sections.get("workspace")
	if (!ws) return null
	const memberPaths = extractTomlArray(ws, "members")
	const slice = memberPaths.slice(0, MAX_WORKSPACE_MEMBERS)
	const resolved = await Promise.all(slice.map((mp) => parseMemberCjpmIntoWorkspaceMember(path.join(cwd, mp), mp)))
	const members = resolved.filter((m): m is WorkspaceMember => m != null)
	let dependencies: CjpmProjectInfo["dependencies"]
	const deps = sections.get("dependencies")
	if (deps) {
		const tables = extractTomlInlineTables(deps)
		if (Object.keys(tables).length > 0) {
			dependencies = {}
			for (const [depName, t] of Object.entries(tables)) {
				dependencies[depName] = { path: t["path"], git: t["git"] }
			}
		}
	}
	return { name: "", version: "", outputType: "", isWorkspace: true, members, dependencies, srcDir: "src" }
}

export async function parseCjpmTomlContent(content: string, cwd: string): Promise<CjpmProjectInfo | null> {
	try {
		const root = parseToml(content) as Record<string, unknown>
		const fromSmol = await projectInfoFromParsedTomlRoot(root, cwd)
		if (fromSmol) return fromSmol
	} catch (e) {
		logger.warn("CangjieContext", "[cangjie-context] smol-toml parse failed, using regex fallback:", e)
	}
	try {
		const sections = splitTomlSections(content)
		if (sections.has("workspace")) {
			return await parseWorkspaceProjectRegexAsync(sections, cwd)
		}
		if (sections.has("package")) {
			return parseSingleModuleProject(sections)
		}
	} catch {
		/* ignore parse errors */
	}
	return null
}

export async function parseCjpmTomlWithMeta(cwd: string): Promise<{ info: CjpmProjectInfo | null; cjpmRawHash: string }> {
	const tomlPath = path.join(cwd, "cjpm.toml")
	const now = Date.now()
	try {
		const st = await fs.promises.stat(tomlPath)
		const cached = cjpmTomlMetaCache.get(cwd)
		if (cached && cached.mtimeMs === st.mtimeMs && now - cached.time < PROJECT_OVERVIEW_CACHE_TTL_MS) {
			return cached.value
		}
		const content = await fs.promises.readFile(tomlPath, "utf-8")
		const info = await parseCjpmTomlContent(content, cwd)
		const value = { info, cjpmRawHash: String(simpleHash(content)) }
		cjpmTomlMetaCache.set(cwd, { mtimeMs: st.mtimeMs, value, time: now })
		if (cjpmTomlMetaCache.size > 64) {
			const first = cjpmTomlMetaCache.keys().next().value as string | undefined
			if (first !== undefined) cjpmTomlMetaCache.delete(first)
		}
		return value
	} catch {
		return { info: null, cjpmRawHash: "no-cjpm" }
	}
}

export async function parseCjpmToml(cwd: string): Promise<CjpmProjectInfo | null> {
	const { info } = await parseCjpmTomlWithMeta(cwd)
	return info
}

// ---------------------------------------------------------------------------
// Package hierarchy scanning
// ---------------------------------------------------------------------------

const PACKAGE_TREE_CACHE_TTL_MS = 60_000
const packageTreeCache = new Map<string, { value: PackageNode | null; time: number }>()

function getPackageTreeCacheKey(cwd: string, srcDir: string, rootPackageName?: string): string {
	return `${cwd}|${srcDir}|${rootPackageName ?? "default"}`
}

export async function getCachedPackageHierarchy(cwd: string, srcDir: string, rootPackageName?: string): Promise<PackageNode | null> {
	const key = getPackageTreeCacheKey(cwd, srcDir, rootPackageName)
	const now = Date.now()
	const hit = packageTreeCache.get(key)
	if (hit && now - hit.time < PACKAGE_TREE_CACHE_TTL_MS) return hit.value
	const value = await scanPackageHierarchy(cwd, srcDir, rootPackageName)
	packageTreeCache.set(key, { value, time: now })
	if (packageTreeCache.size > 128) {
		const first = packageTreeCache.keys().next().value as string | undefined
		if (first !== undefined) packageTreeCache.delete(first)
	}
	return value
}

export async function scanPackageHierarchy(cwd: string, srcDir: string, rootPackageName?: string): Promise<PackageNode | null> {
	const srcPath = path.join(cwd, srcDir)
	try {
		await fs.promises.access(srcPath)
	} catch {
		return null
	}

	let fileCount = 0
	const rootPkg = rootPackageName || "default"

	async function scan(dir: string, depth: number, pkgName: string): Promise<PackageNode | null> {
		if (depth > MAX_SCAN_DEPTH || fileCount > MAX_SCAN_FILES) return null

		let entries: fs.Dirent[]
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true })
		} catch {
			return null
		}

		const sourceFiles: string[] = []
		const testFiles: string[] = []
		let hasMain = false
		const childDirs: fs.Dirent[] = []

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".cj")) {
				fileCount++
				if (entry.name.endsWith("_test.cj")) {
					testFiles.push(entry.name)
				} else {
					sourceFiles.push(entry.name)
					if (entry.name === "main.cj") hasMain = true
				}
			} else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "target") {
				childDirs.push(entry)
			}
		}

		const children: PackageNode[] = []
		for (const cd of childDirs) {
			const childNode = await scan(path.join(dir, cd.name), depth + 1, `${pkgName}.${cd.name}`)
			if (childNode) children.push(childNode)
		}

		if (sourceFiles.length === 0 && testFiles.length === 0 && children.length === 0) return null

		return {
			packageName: pkgName,
			dirPath: path.relative(cwd, dir).replace(/\\/g, "/"),
			sourceFiles,
			testFiles,
			hasMain,
			children,
		}
	}

	return scan(srcPath, 0, rootPkg)
}

function countTreeFiles(node: PackageNode, testOnly: boolean): number {
	const count = testOnly ? node.testFiles.length : node.sourceFiles.length
	return count + node.children.reduce((sum, child) => sum + countTreeFiles(child, testOnly), 0)
}

// ---------------------------------------------------------------------------
// System prompt section formatters
// ---------------------------------------------------------------------------

export async function readWorkspaceMemberDependencies(
	cwd: string,
	member: WorkspaceMember,
): Promise<string[]> {
	if (member.dependencyDisplay && member.dependencyDisplay.length > 0) {
		return member.dependencyDisplay.slice(0, 5)
	}
	let tables: Record<string, Record<string, string>> | undefined
	if (member.dependencies && Object.keys(member.dependencies).length > 0) {
		tables = {}
		for (const [d, meta] of Object.entries(member.dependencies)) {
			tables[d] = { path: meta.path ?? "", git: meta.git ?? "", tag: meta.tag ?? "", branch: meta.branch ?? "" }
		}
	} else {
		const memberToml = path.join(cwd, member.path, "cjpm.toml")
		try {
			await fs.promises.access(memberToml)
		} catch {
			return []
		}
		try {
			const content = await fs.promises.readFile(memberToml, "utf-8")
			const memberSections = splitTomlSections(content)
			const deps = memberSections.get("dependencies")
			if (!deps) return []
			tables = extractTomlInlineTables(deps)
		} catch {
			return []
		}
	}
	if (!tables) return []
	return Object.keys(tables)
		.map((d) => {
			const t = tables![d]!
			if (t["path"]) return `${d}(path:${t["path"]})`
			if (t["git"]) return `${d}(git)`
			if (t["tag"]) return `${d}(tag:${t["tag"]})`
			if (t["branch"]) return `${d}(branch:${t["branch"]})`
			return d
		})
		.slice(0, 5)
}

export async function buildCompactProjectOverviewSection(
	cwd: string,
	info: CjpmProjectInfo,
	activePkg: string | null,
	activeFilePath: string | null,
): Promise<string> {
	const lines: string[] = ["## 当前项目概览（紧凑）\n"]

	if (!info.isWorkspace) {
		const rootPkgName = info.name || undefined
		const pkgTree = await getCachedPackageHierarchy(cwd, info.srcDir, rootPkgName)
		const srcCount = pkgTree ? countTreeFiles(pkgTree, false) : 0
		const testCount = pkgTree ? countTreeFiles(pkgTree, true) : 0
		lines.push(`项目: ${info.name} (${info.outputType}) v${info.version}`)
		lines.push(`目录: ${info.srcDir}/, 源文件: ${srcCount}, 测试文件: ${testCount}`)
		if (activePkg) lines.push(`当前编辑包: ${activePkg}`)
		if (pkgTree) {
			const pkgSummary = [pkgTree.packageName, ...pkgTree.children.map((c) => c.packageName)].slice(0, 6).join(", ")
			lines.push(`包概览: ${pkgSummary}${pkgTree.children.length > 5 ? " ..." : ""}`)
		}
		lines.push(`包声明规则: package 与 ${info.srcDir}/ 目录层级一致`)
		return lines.join("\n")
	}

	const members = info.members ?? []
	const resolvedMembers = members.slice(0, MAX_WORKSPACE_MEMBERS)
	lines.push(`项目: workspace (${resolvedMembers.length} 个模块)`)

	let activeMemberName: string | null = null
	if (activeFilePath) {
		const normalizedActivePath = activeFilePath.replace(/\\/g, "/")
		for (const m of resolvedMembers) {
			const memberRoot = path.join(cwd, m.path).replace(/\\/g, "/")
			if (normalizedActivePath.startsWith(memberRoot)) {
				activeMemberName = m.name
				break
			}
		}
	}

	for (const member of resolvedMembers) {
		const memberCwd = path.join(cwd, member.path)
		const pkgTree = await getCachedPackageHierarchy(memberCwd, "src", member.name)
		const srcCount = pkgTree ? countTreeFiles(pkgTree, false) : 0
		const testCount = pkgTree ? countTreeFiles(pkgTree, true) : 0
		const deps = await readWorkspaceMemberDependencies(cwd, member)
		const activeTag = member.name === activeMemberName ? " ← 当前编辑模块" : ""
		const depSuffix = deps.length > 0 ? `, 依赖: ${deps.join(", ")}` : ""
		lines.push(`- ${member.name} (${member.outputType}): ${srcCount} 源/${testCount} 测${activeTag}${depSuffix}`)
	}

	if (activePkg) lines.push(`当前编辑包: ${activePkg}`)
	lines.push("包声明规则: package 与 src/ 目录层级一致；模块依赖变更后运行 `cjpm check`")
	return lines.join("\n")
}

const CJPM_TREE_CACHE_TTL_MS = 60_000
let cachedCjpmTree: {
	result: string | null
	cwd: string
	tomlMtime: number
	lockMtime: number
	fetchedAt: number
} | null = null

export async function getCjpmTreeSection(cwd: string): Promise<string | null> {
	try {
		const tomlPath = path.join(cwd, "cjpm.toml")
		try {
			await fs.promises.access(tomlPath)
		} catch {
			return null
		}
		const tomlMtime = (await fs.promises.stat(tomlPath)).mtimeMs
		const lockPath = path.join(cwd, "cjpm.lock")
		let lockMtime = 0
		try {
			await fs.promises.access(lockPath)
			lockMtime = (await fs.promises.stat(lockPath)).mtimeMs
		} catch {
			/* lock file doesn't exist */
		}
		const now = Date.now()
		if (
			cachedCjpmTree &&
			cachedCjpmTree.cwd === cwd &&
			cachedCjpmTree.tomlMtime === tomlMtime &&
			cachedCjpmTree.lockMtime === lockMtime &&
			now - cachedCjpmTree.fetchedAt < CJPM_TREE_CACHE_TTL_MS
		) {
			return cachedCjpmTree.result
		}

		const summary = await getCjpmTreeSummaryForPrompt(cwd)
		const result = summary || null
		cachedCjpmTree = { result, cwd, tomlMtime, lockMtime, fetchedAt: now }
		return result
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Dynamic coding rules injection (context-aware)
// ---------------------------------------------------------------------------


export function invalidateCjpmProjectParserCaches(): void {
	cjpmTomlMetaCache.clear()
	packageTreeCache.clear()
	cachedCjpmTree = null
}
