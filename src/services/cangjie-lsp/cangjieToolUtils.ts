import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { Package } from "../../shared/package"
import { logger } from "../../shared/logger"
import { getErrorMessage } from "../../shared/error-utils"

const execFileAsync = promisify(execFile)

/** Relative key under `Package.name` for the Cangjie compiler path (shared by runCode, macro expand, status bar). */
export const CJC_CONFIG_KEY = "cangjieLsp.cjcPath"

let homeDetectCache: string | undefined | null = null
let envBuildCache: { key: string; env: Record<string, string> } | null = null

/** Call when workspace settings that affect SDK paths may have changed. */
export function invalidateCangjieToolEnvCache(): void {
	homeDetectCache = null
	envBuildCache = null
}

/**
 * Detect CANGJIE_HOME from environment or well-known install locations.
 */
export function detectCangjieHome(): string | undefined {
	if (homeDetectCache !== null) return homeDetectCache

	// 1. Environment variable
	if (process.env.CANGJIE_HOME && fs.existsSync(process.env.CANGJIE_HOME)) {
		homeDetectCache = process.env.CANGJIE_HOME
		return homeDetectCache
	}

	// 2. Infer from VS Code LSP serverPath config (aligns with CangjieLspClient)
	try {
		const serverPath = vscode.workspace.getConfiguration("njust-ai.cangjieLsp").get<string>("serverPath")
		if (serverPath && fs.existsSync(serverPath)) {
			const sdkRoot = path.resolve(serverPath, "..", "..")
			if (fs.existsSync(path.join(sdkRoot, "bin"))) {
				homeDetectCache = sdkRoot
				return homeDetectCache
			}
		}
	} catch {
		/* vscode not available (tests) */
	}

	const wellKnownPaths =
		process.platform === "win32"
			? ["D:\\cangjie", "C:\\cangjie", path.join(process.env.LOCALAPPDATA || "", "cangjie")]
			: ["/usr/local/cangjie", path.join(process.env.HOME || "", ".cangjie")]

	for (const p of wellKnownPaths) {
		if (p && fs.existsSync(path.join(p, "bin"))) {
			homeDetectCache = p
			return homeDetectCache
		}
	}

	homeDetectCache = undefined
	return undefined
}

/**
 * Build environment variables for running Cangjie SDK tools.
 * Ensures runtime libraries are on PATH / LD_LIBRARY_PATH.
 */
export function buildCangjieToolEnv(cangjieHome?: string): Record<string, string> {
	const home = cangjieHome ?? detectCangjieHome()
	const cacheKey = `${home ?? "__nohome__"}|${process.platform}`
	if (envBuildCache && envBuildCache.key === cacheKey) {
		return { ...envBuildCache.env }
	}

	if (!home) {
		const env = { ...process.env } as Record<string, string>
		envBuildCache = { key: cacheKey, env }
		return env
	}

	const env = { ...process.env } as Record<string, string>
	env["CANGJIE_HOME"] = home

	const sep = process.platform === "win32" ? ";" : ":"
	const extraPaths: string[] = []

	if (process.platform === "win32") {
		extraPaths.push(path.join(home, "runtime", "lib", "windows_x86_64_llvm"))
		extraPaths.push(path.join(home, "lib", "windows_x86_64_llvm"))
	} else {
		extraPaths.push(path.join(home, "runtime", "lib", "linux_x86_64_llvm"))
		extraPaths.push(path.join(home, "lib", "linux_x86_64_llvm"))
	}
	extraPaths.push(path.join(home, "bin"))
	extraPaths.push(path.join(home, "tools", "bin"))
	extraPaths.push(path.join(home, "tools", "lib"))

	const existing = env["PATH"] || env["Path"] || ""
	const updatedPath = extraPaths.filter((p) => fs.existsSync(p)).join(sep) + sep + existing
	if (process.platform === "win32") {
		const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path")
		for (const key of new Set([...pathKeys, "Path"])) {
			env[key] = updatedPath
		}
	} else {
		env["PATH"] = updatedPath
	}

	if (process.platform !== "win32") {
		const ldPaths = extraPaths.filter((p) => fs.existsSync(p))
		const existingLd = env["LD_LIBRARY_PATH"] || ""
		if (ldPaths.length > 0) {
			env["LD_LIBRARY_PATH"] = ldPaths.join(sep) + (existingLd ? sep + existingLd : "")
		}
	}

	envBuildCache = { key: cacheKey, env }
	return { ...env }
}

/**
 * Resolve a Cangjie SDK tool executable by checking:
 * 1. User-configured path in settings
 * 2. CANGJIE_HOME environment variable
 * 3. Well-known install locations
 * 4. System PATH (fallback)
 */
export function resolveCangjieToolPath(toolName: string, configKey?: string): string | undefined {
	if (configKey) {
		const configured = vscode.workspace.getConfiguration(Package.name).get<string>(configKey, "")
		if (configured) {
			const resolved = path.resolve(configured)
			if (fs.existsSync(resolved)) return resolved
			return undefined
		}
	}

	const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName

	const cangjieHome = detectCangjieHome()
	if (cangjieHome) {
		const candidates = [path.join(cangjieHome, "bin", exeName), path.join(cangjieHome, "tools", "bin", exeName)]
		for (const c of candidates) {
			if (fs.existsSync(c)) return c
		}
	}

	logger.warn(
		"CangjieToolUtils",
		`Cannot locate ${toolName}: no configured path, ` +
			`CANGJIE_HOME not set, and not found in well-known install locations. ` +
			`Falling back to bare "${exeName}" — commands may fail with ENOENT.`,
	)
	return exeName
}

export type CangjieToolkitId = "cjc" | "cjpm" | "cjfmt" | "cjlint"

/** cjfmt / cjc / cjpm 各发行版 CLI 略有差异；探测时依次尝试。 */
function probeTryArgsForTool(id: CangjieToolkitId): string[][] {
	if (id === "cjlint") {
		return [["--version"], ["-V"], ["-h"]]
	}
	if (id === "cjfmt") {
		// 多数 Cangjie SDK 中 cjfmt 不支持 `--version`，会误解析为 `--`；优先 -V / -h
		return [["-V"], ["-h"], ["--help"], ["--version"]]
	}
	return [["--version"]]
}

/**
 * 当 resolve 回落为裸可执行名时，再按 CANGJIE_HOME 拼绝对路径，避免 Windows 下 PATH/spawn 未命中。
 */
function absolutizeSdkToolIfBare(id: CangjieToolkitId, invokedPath: string): string {
	const hasSep = invokedPath.includes(path.sep) || invokedPath.includes("/") || invokedPath.includes("\\")
	if (path.isAbsolute(invokedPath) || hasSep) {
		return invokedPath
	}
	const home = detectCangjieHome()
	if (!home) return invokedPath
	const exe = process.platform === "win32" ? `${id}.exe` : id
	for (const rel of ["bin", path.join("tools", "bin")]) {
		const candidate = path.join(home, rel, exe)
		if (fs.existsSync(candidate)) return candidate
	}
	return invokedPath
}

export interface CangjieToolProbeResult {
	id: CangjieToolkitId
	label: string
	configKey?: string
	invokedPath: string
	ok: boolean
	versionLine?: string
	hint?: string
}

/**
 * Run version/help probes on each tool; used by **Cangjie: Verify SDK Installation**.
 */
export async function probeCangjieToolchain(): Promise<CangjieToolProbeResult[]> {
	const defs: Array<{ id: CangjieToolkitId; configKey?: string }> = [
		{ id: "cjc", configKey: CJC_CONFIG_KEY },
		{ id: "cjpm", configKey: "cangjieTools.cjpmPath" },
		{ id: "cjfmt", configKey: "cangjieTools.cjfmtPath" },
		{ id: "cjlint", configKey: "cangjieTools.cjlintPath" },
	]
	const env = buildCangjieToolEnv() as NodeJS.ProcessEnv
	const out: CangjieToolProbeResult[] = []

	for (const { id, configKey } of defs) {
		const resolved = resolveCangjieToolPath(id, configKey)
		const configured = configKey ? vscode.workspace.getConfiguration(Package.name).get<string>(configKey, "") : ""
		const looksConfigured = Boolean(configKey && configured.length > 0)

		if (looksConfigured && resolved === undefined) {
			out.push({
				id,
				label: id,
				configKey,
				invokedPath: path.resolve(configured),
				ok: false,
				hint: `已启用 ${configKey}，但文件不存在`,
			})
			continue
		}

		let invokedPath = resolved ?? (process.platform === "win32" ? `${id}.exe` : id)
		invokedPath = absolutizeSdkToolIfBare(id, invokedPath)
		const isConcretePath =
			path.isAbsolute(invokedPath) ||
			invokedPath.includes(path.sep) ||
			invokedPath.includes("/") ||
			invokedPath.includes("\\")

		if (looksConfigured && isConcretePath && !fs.existsSync(invokedPath)) {
			out.push({
				id,
				label: id,
				configKey,
				invokedPath,
				ok: false,
				hint: `已启用 ${configKey}，但文件不存在`,
			})
			continue
		}

		try {
			const tryArgs = probeTryArgsForTool(id)
			let stdout = ""
			let lastErr: unknown
			for (const args of tryArgs) {
				try {
					const r = await execFileAsync(invokedPath, args, { timeout: 12_000, env })
					stdout = [r.stdout, r.stderr].filter((s) => s && String(s).trim()).join("\n")
					lastErr = undefined
					break
				} catch (e) {
					lastErr = e
				}
			}
			if (lastErr !== undefined) throw lastErr
			const versionLine =
				stdout
					.trim()
					.split("\n")
					.filter((l) => l.trim())[0] ?? ""
			out.push({
				id,
				label: id,
				configKey,
				invokedPath,
				ok: true,
				versionLine: versionLine || "(no output)",
			})
		} catch (e) {
			const msg = getErrorMessage(e)
			out.push({
				id,
				label: id,
				configKey,
				invokedPath,
				ok: false,
				hint: msg.slice(0, 200),
			})
		}
	}

	return out
}

export function formatCangjieToolchainReport(probes: CangjieToolProbeResult[]): string {
	const lines = ["=== Cangjie 工具链诊断 ===", `CANGJIE_HOME: ${detectCangjieHome() ?? "(未检测到)"}`, ""]
	for (const p of probes) {
		const cfg = p.configKey ? ` [${p.configKey}]` : ""
		if (p.ok) {
			lines.push(`✓ ${p.label}${cfg}: ${p.versionLine} (${p.invokedPath})`)
		} else {
			lines.push(`✗ ${p.label}${cfg}: ${p.hint ?? "不可用"} (${p.invokedPath})`)
		}
	}
	return lines.join("\n")
}

/** Short checklist for onboarding toast after SDK path is set. */
export async function formatCangjieToolchainSummaryLine(): Promise<string | undefined> {
	const probes = await probeCangjieToolchain()
	const parts = probes.map((p) => `${p.label}${p.ok ? "✓" : "✗"}`).join(" ")
	const allOk = probes.every((p) => p.ok)
	if (!allOk) {
		const missing = probes.filter((p) => !p.ok).map((p) => p.label)
		return `Cangjie 工具链: ${parts}\n缺失: ${missing.join(", ")} — 可在命令面板运行「Cangjie: Verify SDK Installation」`
	}
	const ver = probes.find((p) => p.id === "cjc")?.versionLine
	return ver ? `Cangjie SDK 已就绪: ${ver} (${parts})` : `Cangjie SDK 已就绪 (${parts})`
}

// ---------------------------------------------------------------------------
// LSP ahead-of-time query utilities
// ---------------------------------------------------------------------------

/**
 * Get all symbol definitions in a file with their signatures.
 * Useful for AI to understand what a file exports before modifying it.
 */
export function getSymbolContextForFile(filePath: string): string | null {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Circular dependency: CangjieSymbolIndex imports cangjieToolUtils
	const { CangjieSymbolIndex } = require("./CangjieSymbolIndex")
	const index = CangjieSymbolIndex.getInstance()
	if (!index) return null

	const normalized = path.resolve(filePath)
	const symbols = index
		.getSymbolsByDirectory(path.dirname(normalized))
		.filter((s: { filePath: string }) => path.resolve(s.filePath) === normalized)

	if (symbols.length === 0) return null

	const lines = symbols.map((s: { kind: string; name: string; signature: string; startLine: number }) => {
		const sig = s.signature ? `: \`${s.signature}\`` : ""
		return `- ${s.kind} **${s.name}**${sig} (line ${s.startLine + 1})`
	})

	return `文件 ${path.basename(filePath)} 的符号:\n${lines.join("\n")}`
}

/**
 * Find all references to a symbol name across the workspace.
 * Helps AI understand impact before renaming or modifying a function/type.
 */
export function getReferencesForSymbol(symbolName: string): string | null {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Circular dependency: CangjieSymbolIndex imports cangjieToolUtils
	const { CangjieSymbolIndex } = require("./CangjieSymbolIndex")
	const index = CangjieSymbolIndex.getInstance()
	if (!index) return null

	const refs = index.findReferences(symbolName)
	if (refs.length === 0) return null

	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ""
	const grouped = new Map<string, number[]>()

	for (const ref of refs.slice(0, 50)) {
		const relPath = path.relative(cwd, ref.filePath).replace(/\\/g, "/")
		if (!grouped.has(relPath)) grouped.set(relPath, [])
		grouped.get(relPath)!.push(ref.line + 1)
	}

	const lines = Array.from(grouped.entries()).map(
		([file, lineNums]) => `- ${file}: 行 ${lineNums.slice(0, 10).join(", ")}${lineNums.length > 10 ? " …" : ""}`,
	)

	return `符号 "${symbolName}" 的引用 (${refs.length} 处):\n${lines.join("\n")}`
}

/**
 * Auto-detect the correct `package` declaration for a file based on its
 * path relative to the project's src directory.
 * Returns null if the package can't be determined.
 */
export function autoDetectPackageDeclaration(filePath: string): string | null {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!cwd) return null

	const cjpmToml = path.join(cwd, "cjpm.toml")
	if (!fs.existsSync(cjpmToml)) return null

	try {
		const content = fs.readFileSync(cjpmToml, "utf-8")
		const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m)
		const srcDirMatch = content.match(/^\s*src-dir\s*=\s*"([^"]+)"/m)
		const rootName = nameMatch?.[1] || "default"
		const srcDir = srcDirMatch?.[1] || "src"

		const srcRoot = path.resolve(cwd, srcDir)
		const absFile = path.resolve(filePath)

		if (!absFile.startsWith(srcRoot)) return null

		const relDir = path.relative(srcRoot, path.dirname(absFile))
		if (!relDir || relDir === ".") {
			return rootName
		}

		const subPackage = relDir.replace(/[\\/]/g, ".")
		return `${rootName}.${subPackage}`
	} catch {
		return null
	}
}
