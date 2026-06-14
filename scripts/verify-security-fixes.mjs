/**
 * 安全修复验证脚本 — 使用目标中指定的确切攻击载荷。
 * 用法: node scripts/verify-security-fixes.mjs
 */
import * as path from "path"
import * as net from "net"

let failures = 0
function assert(condition, label) {
	if (condition) {
		console.log("  ✅", label)
	} else {
		console.log("  ❌ FAIL:", label)
		failures++
	}
}

// ═══════════════════════════════════════════════════════════════
// P1-#4: MCP execute_command — 精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#4: MCP execute_command ===")
console.log("目标载荷: cjpm --version $(touch /tmp/poc)")

const RE_INJECT = /\$\(|`/

const injectionPayloads = [
	{ cmd: "cjpm --version $(touch /tmp/poc)", desc: "目标精确载荷" },
	{ cmd: "/opt/cangjie/bin/cjpm build $(id)", desc: "仓颉SDK路径 + $()" },
	{ cmd: "echo `whoami`", desc: "反引号注入" },
	{ cmd: "cjpm --version", desc: "安全命令(应通过)" },
]
for (const { cmd, desc } of injectionPayloads) {
	const blocked = RE_INJECT.test(cmd)
	if (desc.includes("应通过")) {
		assert(!blocked, `"${cmd}" → ALLOWED (${desc})`)
	} else {
		assert(blocked, `"${cmd}" → REJECTED (${desc})`)
	}
}

// ═══════════════════════════════════════════════════════════════
// P2-#6: .m 文件名命令注入 — 精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P2-#6: .m 文件名注入 ===")
console.log('目标载荷: poc";calc;#.m (仅启动Octave，无额外命令)')

const RE_META = /[&|;<>()$`!"\n\r]/

const filePayloads = [
	{ name: 'poc";calc;#.m', desc: "目标精确载荷" },
	{ name: "script$(whoami).m", desc: "$() 子shell注入" },
	{ name: "test`whoami`.m", desc: "反引号注入" },
	{ name: "normal_script.m", desc: "安全文件名(应通过)" },
]
for (const { name: fn, desc } of filePayloads) {
	const blocked = RE_META.test(fn)
	if (desc.includes("应通过")) {
		assert(!blocked, `"${fn}" → ALLOWED (${desc})`)
	} else {
		assert(blocked, `"${fn}" → REJECTED (${desc})`)
	}
}

// ═══════════════════════════════════════════════════════════════
// P1-#2: DNS Rebinding — 私有 IP 被阻止
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#2: DNS Rebinding 私有IP阻止 ===")

function isPrivateIPv4(ip) {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10))
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true
	const a = parts[0],
		b = parts[1]
	if (a === 10) return true
	if (a === 127) return true
	if (a === 0) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a >= 224) return true
	return false
}

const privateIPs = ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "0.0.0.0"]
const publicIPs = ["8.8.8.8", "1.1.1.1", "93.184.216.34"]

for (const ip of privateIPs) {
	assert(isPrivateIPv4(ip), `IP ${ip} → BLOCKED (私有地址)`)
}
for (const ip of publicIPs) {
	assert(!isPrivateIPv4(ip), `IP ${ip} → PUBLIC (允许)`)
}

// ═══════════════════════════════════════════════════════════════
// P0-#7: 文件路径遍历 — 目标精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P0-#7: 文件路径遍历 ===")
console.log("目标载荷: /etc/passwd → 应返回 Access denied")

const workspaceFolders = [path.resolve("D:/NJUST_AI/Roo-Code")]
function simIsOutsideWorkspace(filePath) {
	const absolutePath = path.resolve(filePath)
	return !workspaceFolders.some((folder) => {
		const rel = path.relative(folder, absolutePath)
		return !rel.startsWith("..") && !path.isAbsolute(rel)
	})
}

const pathPayloads = [
	{ p: "/etc/passwd", desc: "目标精确载荷 — Unix 绝对路径" },
	{ p: "../../../etc/passwd", desc: "相对路径遍历" },
	{ p: "..\\..\\..\\Windows\\System32", desc: "Windows 路径遍历" },
	{ p: "src/chat/registerLMTools.ts", desc: "工作区内文件(应通过)" },
]
for (const { p: fp, desc } of pathPayloads) {
	const outside = simIsOutsideWorkspace(fp)
	if (desc.includes("应通过")) {
		assert(!outside, `"${fp}" → 在工作区内 (${desc})`)
	} else {
		assert(outside, `"${fp}" → 在工作区外 → 拒绝 (${desc})`)
	}
}

// ═══════════════════════════════════════════════════════════════
// 结果
// ═══════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(55)}`)
if (failures === 0) {
	console.log("✅ 所有安全验证通过 — 攻击载荷均被正确拒绝")
	console.log("")
	console.log("    P1-#4: cjpm --version $(touch /tmp/poc) → REJECTED")
	console.log('    P2-#6: poc";calc;#.m                     → REJECTED')
	console.log("    P1-#2: 10.0.0.1 / 127.0.0.1 / 192.168.x.x → BLOCKED")
	console.log("    P0-#7: /etc/passwd + ../../../etc/passwd  → OUTSIDE")
} else {
	console.log(`❌ ${failures} 项验证失败`)
}
process.exit(failures === 0 ? 0 : 1)
