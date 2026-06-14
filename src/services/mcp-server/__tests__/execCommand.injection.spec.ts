/**
 * P1-#4 运行时验证：实际调用 execCommand() 函数，使用目标精确载荷。
 * 完整测试命令注入拒绝管道——不跳过任何检查层。
 */
import { describe, it, expect, afterEach } from "vitest"
import * as path from "path"
import * as fs from "fs/promises"
import { execCommand } from "../tool-executors"
import { tmpdir } from "os"
import { rm, mkdtemp } from "fs/promises"

describe("execCommand injection — 实际函数调用 + 目标精确载荷", () => {
	let tempDir: string
	let workspaceCwd: string

	async function setup() {
		tempDir = await mkdtemp(path.join(tmpdir(), "exec-inj-real-"))
		workspaceCwd = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceCwd, { recursive: true })
	}

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	it("目标载荷: cjpm --version $(touch /tmp/poc) → 返回错误", async () => {
		await setup()
		await expect(execCommand(workspaceCwd, { command: "cjpm --version $(touch /tmp/poc)" })).rejects.toThrow(
			"Command injection detected in MCP context",
		)
	}, 10000)

	it("即使 cjpm 在 allowedCommands 中, $() 仍被拒绝", async () => {
		await setup()
		await expect(execCommand(workspaceCwd, { command: "cjpm build $(id)" }, ["cjpm"])).rejects.toThrow(
			"Command injection detected in MCP context",
		)
	}, 10000)

	it("即使 wildcard * 允许所有命令, $() 仍被拒绝", async () => {
		await setup()
		await expect(execCommand(workspaceCwd, { command: "npm --version $(whoami)" }, ["*"])).rejects.toThrow(
			"Command injection detected in MCP context",
		)
	}, 10000)

	it("反引号注入: echo `whoami` → 返回错误", async () => {
		await setup()
		await expect(execCommand(workspaceCwd, { command: "echo `whoami`" })).rejects.toThrow(
			"Command injection detected in MCP context",
		)
	}, 10000)

	it("对照: 安全命令 echo test 应正常执行", async () => {
		await setup()
		await expect(execCommand(workspaceCwd, { command: "echo test" })).resolves.toContain("Exit code:")
	}, 10000)
})
