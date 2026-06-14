/**
 * P2-#6 运行时验证：目标载荷 poc";calc;#.m 被 shell 元字符检测拒绝。
 */
import { describe, it, expect } from "vitest"

// 与 runCode.ts 中 containsShellMetacharacters 一致的正则
const RE_META = /[&|;<>()$`!"\n\r]/

describe("P2-#6: .m 文件名注入 — 确切载荷验证", () => {
	it('目标载荷 poc";calc;#.m → REJECTED', () => {
		const maliciousPath = 'D:\\repo\\poc";calc;#.m'
		expect(RE_META.test(maliciousPath)).toBe(true)
	})

	it("script$(whoami).m → REJECTED ($() 子shell)", () => {
		expect(RE_META.test("script$(whoami).m")).toBe(true)
	})

	it("test`whoami`.m → REJECTED (反引号)", () => {
		expect(RE_META.test("test`whoami`.m")).toBe(true)
	})

	it('script"name.m → REJECTED (双引号 — P2-#6 新增)', () => {
		expect(RE_META.test('script"name.m')).toBe(true)
	})

	it("normal_script.m → ALLOWED (无元字符)", () => {
		expect(RE_META.test("normal_script.m")).toBe(false)
	})
})
