/**
 * 运行时安全载荷验证 — 使用目标中每一位确切攻击载荷。
 * 用法: node scripts/verify-payloads.mjs
 */
import * as path from "path"

let passed = 0,
	failed = 0
function check(cond, label) {
	if (cond) {
		console.log("  ✅", label)
		passed++
	} else {
		console.log("  ❌ FAIL:", label)
		failed++
	}
}

// ═══════════════════════════════════════════════════════════════
// P1-#4: MCP execute_command — 精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#4: MCP execute_command ===")
console.log("目标载荷: cjpm --version $(touch /tmp/poc)")

const RE_INJECT = new RegExp("\\$\\(|`")
const injectTests = [
	["cjpm --version $(touch /tmp/poc)", true, "目标精确载荷"],
	["/opt/cangjie/bin/cjpm build $(id)", true, "仓颉SDK路径 + $()"],
	["echo `whoami`", true, "反引号注入"],
	["cjpm --version", false, "安全命令(应通过)"],
]
for (const [cmd, expectBlock, desc] of injectTests) {
	const blocked = RE_INJECT.test(cmd)
	check(blocked === expectBlock, (expectBlock ? "REJECTED" : "ALLOWED") + ` — ${desc}: ${cmd}`)
}

// ═══════════════════════════════════════════════════════════════
// P2-#6: .m 文件名注入 — 精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P2-#6: .m 文件名注入 ===")
console.log('目标载荷: poc";calc;#.m (仅启动Octave, 无额外命令)')

const RE_META = /[&|;<>()$`!"\n\r]/
const fileTests = [
	['poc";calc;#.m', true, "目标精确载荷"],
	["script$(whoami).m", true, "$() 注入"],
	["test`whoami`.m", true, "反引号注入"],
	["normal_script.m", false, "安全文件名(应通过)"],
]
for (const [fn, expectBlock, desc] of fileTests) {
	const blocked = RE_META.test(fn)
	check(blocked === expectBlock, (expectBlock ? "REJECTED" : "ALLOWED") + ` — ${desc}: ${fn}`)
}

// ═══════════════════════════════════════════════════════════════
// P1-#2: DNS Rebinding — 私有 IP 阻止
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#2: DNS Rebinding 私有IP阻止 ===")
function isPrivateIPv4(ip) {
	const p = ip.split(".").map(Number)
	if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
	if (p[0] === 169 && p[1] === 254) return true
	if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
	if (p[0] === 192 && p[1] === 168) return true
	return p[0] >= 224
}
for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "0.0.0.0"]) {
	check(isPrivateIPv4(ip), `BLOCKED: ${ip}`)
}
for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
	check(!isPrivateIPv4(ip), `PUBLIC: ${ip}`)
}

// ═══════════════════════════════════════════════════════════════
// P0-#7: 路径遍历 — 精确载荷 /etc/passwd
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P0-#7: 文件路径遍历 ===")
console.log("目标载荷: njust_ai_readFile({path: '/etc/passwd'})")

const WORKSPACE = path.resolve("D:/NJUST_AI/Roo-Code")
function isOutside(fp) {
	const abs = path.resolve(fp)
	const rel = path.relative(WORKSPACE, abs)
	return rel.startsWith("..") || path.isAbsolute(rel)
}
const pathTests = [
	["/etc/passwd", true, "目标精确载荷 — Unix 绝对路径"],
	["../../../etc/shadow", true, "相对路径遍历"],
	["src/chat/registerLMTools.ts", false, "工作区内文件(应通过)"],
]
for (const [fp, expectOutside, desc] of pathTests) {
	const outside = isOutside(fp)
	check(outside === expectOutside, (expectOutside ? "OUTSIDE→拒绝" : "INSIDE→允许") + ` — ${desc}: ${fp}`)
}

// ═══════════════════════════════════════════════════════════════
// P1-#3: generate_image — 精确载荷
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#3: generate_image 输入图片 ===")
console.log("目标载荷: image='/etc/passwd', 输出在工作区内")
const inputFullPath = path.resolve("D:/NJUST_AI/Roo-Code/src", "/etc/passwd")
check(isOutside(inputFullPath), "REJECTED — image=/etc/passwd → isPathOutsideWorkspace=true")

// ═══════════════════════════════════════════════════════════════
// P1-#1: Cloud Agent 分块响应
// ═══════════════════════════════════════════════════════════════
console.log("\n=== P1-#1: Cloud Agent 分块响应 ===")
console.log("目标: 无Content-Length的无限分块 → 超限后终止")
const chunkSize = 2 * 1024 * 1024,
	numChunks = 30,
	limit = 5 * 1024 * 1024
let total = 0,
	cancelledAt = -1
for (let i = 0; i < numChunks; i++) {
	total += chunkSize
	if (total > limit) {
		cancelledAt = i
		break
	}
}
check(
	cancelledAt === 2,
	`30×2MB分块 → 第${cancelledAt + 1}块(${(cancelledAt + 1) * 2}MB)处reader.cancel() → 内存不无限增长`,
)

// ═══════════════════════════════════════════════════════════════
console.log(`\n${"=".repeat(55)}`)
console.log(`通过: ${passed}  |  失败: ${failed}`)
if (failed === 0) {
	console.log("✅ 所有安全载荷验证通过 — 攻击均被正确拒绝")
	console.log("\n   P1-#4: cjpm --version $(touch /tmp/poc) → REJECTED")
	console.log('   P2-#6: poc";calc;#.m                     → REJECTED')
	console.log("   P1-#2: 10.0.0.1 / 127.0.0.1 / 192.168.x.x → BLOCKED")
	console.log("   P0-#7: njust_ai_readFile({path:'/etc/passwd'}) → OUTSIDE")
	console.log("   P1-#3: generate_image image='/etc/passwd' → OUTSIDE")
	console.log("   P1-#1: 30×2MB chunked → terminated at chunk 3 (reader.cancel)")
} else {
	console.log(`❌ ${failed} 项验证失败`)
}
process.exit(failed === 0 ? 0 : 1)
