/**
 * check-bundle-size.mjs
 *
 * CI 防回归脚本：检查 extension.js 的打包大小是否在阈值内。
 * 同时输出各关键组成部分的大小供分析用。
 *
 * 用法：node scripts/check-bundle-size.mjs [--json]
 */

import { statSync, existsSync, readdirSync } from "node:fs"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "..")
const distDir = resolve(rootDir, "src/dist")

// ── 配置 ─────────────────────────────────────────────────────────
// extension.js 的最大允许大小（字节）。
// 当前基线约 16.9MB（2026-06-03 生产构建测量），此阈值允许合理波动。
// KR2.2 目标 ≤ 30MB，当前已达标。
const EXTENSION_JS_LIMIT_MB = 25
const EXTENSION_JS_LIMIT_BYTES = EXTENSION_JS_LIMIT_MB * 1024 * 1024

// ── 工具函数 ─────────────────────────────────────────────────────

function formatBytes(bytes) {
	const mb = bytes / (1024 * 1024)
	return `${mb.toFixed(2)} MB`
}

function getFileSize(filePath) {
	if (!existsSync(filePath)) return null
	return statSync(filePath).size
}

function getDirSize(dirPath) {
	if (!existsSync(dirPath)) return 0
	let total = 0
	const entries = readdirSync(dirPath, { withFileTypes: true })
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name)
		if (entry.isFile()) {
			total += statSync(fullPath).size
		} else if (entry.isDirectory()) {
			total += getDirSize(fullPath)
		}
	}
	return total
}

function getWasmFilesSize() {
	if (!existsSync(distDir)) return { total: 0, files: [] }
	const entries = readdirSync(distDir)
	const wasmFiles = entries.filter((f) => f.endsWith(".wasm"))
	const files = wasmFiles.map((f) => ({
		name: f,
		size: getFileSize(join(distDir, f)),
	}))
	return { total: files.reduce((sum, f) => sum + f.size, 0), files }
}

// ── 主逻辑 ───────────────────────────────────────────────────────

const outputJson = process.argv.includes("--json")

if (!existsSync(distDir)) {
	console.error("❌ dist 目录不存在。请先运行 `pnpm --filter @njust-ai/vscode bundle`。")
	process.exit(2)
}

const extensionJsPath = join(distDir, "extension.js")
const extensionJsSize = getFileSize(extensionJsPath)

if (extensionJsSize === null) {
	console.error("❌ extension.js 不存在。请先运行构建。")
	process.exit(2)
}

const wasmInfo = getWasmFilesSize()
const workersSize = getDirSize(join(distDir, "workers"))
const webviewSize = getDirSize(join(distDir, "webview-ui"))
const i18nSize = getDirSize(join(distDir, "i18n"))
const assetsSize = getDirSize(join(distDir, "assets"))
const totalDistSize = getDirSize(distDir)

const report = {
	timestamp: new Date().toISOString(),
	extensionJs: {
		path: "src/dist/extension.js",
		sizeBytes: extensionJsSize,
		sizeMB: +(extensionJsSize / (1024 * 1024)).toFixed(2),
		limitMB: EXTENSION_JS_LIMIT_MB,
		withinLimit: extensionJsSize <= EXTENSION_JS_LIMIT_BYTES,
	},
	components: {
		wasm: { sizeMB: +(wasmInfo.total / (1024 * 1024)).toFixed(2), fileCount: wasmInfo.files.length },
		workers: { sizeMB: +(workersSize / (1024 * 1024)).toFixed(2) },
		webviewUi: { sizeMB: +(webviewSize / (1024 * 1024)).toFixed(2) },
		i18n: { sizeMB: +(i18nSize / (1024 * 1024)).toFixed(2) },
		assets: { sizeMB: +(assetsSize / (1024 * 1024)).toFixed(2) },
	},
	totalDist: { sizeMB: +(totalDistSize / (1024 * 1024)).toFixed(2) },
}

if (outputJson) {
	console.log(JSON.stringify(report, null, 2))
} else {
	console.log("📦 Bundle Size Report\n")
	console.log(`   extension.js:    ${formatBytes(extensionJsSize)}`)
	console.log(`   阈值:           ${EXTENSION_JS_LIMIT_MB} MB`)
	console.log(`   状态:           ${report.extensionJs.withinLimit ? "✅ 在阈值内" : "❌ 超出阈值！"}\n`)
	console.log("   组成部分:")
	console.log(`     wasm 文件:    ${formatBytes(wasmInfo.total)} (${wasmInfo.files.length} 个文件)`)
	console.log(`     workers:      ${formatBytes(workersSize)}`)
	console.log(`     webview-ui:   ${formatBytes(webviewSize)}`)
	console.log(`     i18n:         ${formatBytes(i18nSize)}`)
	console.log(`     assets:       ${formatBytes(assetsSize)}`)
	console.log(`     ──────────────────────`)
	console.log(`     dist 总计:    ${formatBytes(totalDistSize)}\n`)

	// 输出前 5 大 wasm 文件
	if (wasmInfo.files.length > 0) {
		console.log("   Top 5 wasm 文件:")
		wasmInfo.files
			.sort((a, b) => b.size - a.size)
			.slice(0, 5)
			.forEach((f) => {
				console.log(`     ${f.name}: ${formatBytes(f.size)}`)
			})
		console.log("")
	}
}

if (!report.extensionJs.withinLimit) {
	console.error(
		`❌ extension.js (${formatBytes(extensionJsSize)}) 超过阈值 (${EXTENSION_JS_LIMIT_MB} MB)。` +
			`请分析 dist/metafile.json 找出大包依赖并优化。`,
	)
	process.exit(1)
}

console.log("✅ Bundle size 检查通过。")
process.exit(0)
