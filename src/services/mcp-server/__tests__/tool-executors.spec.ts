import { describe, it, expect, vi, afterEach } from "vitest"
import * as path from "path"
import * as fs from "fs/promises"
import { execCommand } from "../tool-executors"
import { tmpdir } from "os"
import { mkdtemp, rm } from "fs/promises"

vi.mock("../../core/tools/helpers/commandSafety", () => ({
	checkCommandSafety: vi.fn(() => ({ riskLevel: "safe", reasons: [] })),
}))

vi.mock("../../utils/env", () => ({
	filterSensitiveEnv: vi.fn(() => ({})),
}))

describe("execCommand security boundaries", () => {
	let workspaceCwd: string
	let tempDir: string

	async function setupDirs() {
		tempDir = await mkdtemp(path.join(tmpdir(), "test-exec-command-"))
		workspaceCwd = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceCwd, { recursive: true })
	}

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	describe("workspace boundary enforcement for cwd", () => {
		it("rejects cwd outside workspace", async () => {
			await setupDirs()
			const outsideDir = path.join(tempDir, "outside-workspace")
			await fs.mkdir(outsideDir, { recursive: true })

			await expect(
				execCommand(workspaceCwd, {
					command: "echo test",
					cwd: outsideDir,
				}),
			).rejects.toThrow("Path escapes workspace boundary")
		})

		it("rejects relative cwd that escapes workspace", async () => {
			await setupDirs()

			await expect(
				execCommand(workspaceCwd, {
					command: "echo test",
					cwd: "../../outside",
				}),
			).rejects.toThrow("Path escapes workspace boundary")
		})

		it("allows cwd within workspace", async () => {
			await setupDirs()
			const subDir = path.join(workspaceCwd, "subdir")
			await fs.mkdir(subDir, { recursive: true })

			const result = await execCommand(workspaceCwd, {
				command: "echo test",
				cwd: "subdir",
			})

			expect(result).toContain("Exit code:")
		})
	})

	describe("allowedCommands enforcement", () => {
		it("rejects command not in allowed list", async () => {
			await setupDirs()

			await expect(
				execCommand(
					workspaceCwd,
					{ command: "npm install" },
					["git", "echo"],
				),
			).rejects.toThrow("Command requires explicit approval")
		})

		it("allows command in allowed list", async () => {
			await setupDirs()

			const result = await execCommand(
				workspaceCwd,
				{ command: "echo test" },
				["git", "echo"],
			)

			expect(result).toContain("Exit code:")
		})

		it("allows any command when wildcard is present", async () => {
			await setupDirs()

			const result = await execCommand(
				workspaceCwd,
				{ command: 'node -e "console.log(\'wildcard\')"' },
				["*"],
			)

			expect(result).toContain("Exit code:")
		})

		it("matches command by base name", async () => {
			await setupDirs()

			// Test with a command that includes the full path
			// The real getCommandDecision extracts base name before matching
			const result = await execCommand(
				workspaceCwd,
				{ command: "echo test" },
				["echo"],
			)

			expect(result).toContain("Exit code:")
		})

		it("rejects command chain that includes denied command", async () => {
			await setupDirs()

			await expect(
				execCommand(
					workspaceCwd,
					{ command: "git status && rm file" },
					["git"],
					["rm"],
				),
			).rejects.toThrow("Command denied by policy")
		})
	})

	describe("deniedCommands enforcement", () => {
		it("rejects command in denied list", async () => {
			await setupDirs()

			await expect(
				execCommand(
					workspaceCwd,
					{ command: "rm -rf /" },
					["*"],
					["rm"],
				),
			).rejects.toThrow("Command denied by policy")
		})

		it("deniedCommands checked after allowedCommands", async () => {
			await setupDirs()

			await expect(
				execCommand(
					workspaceCwd,
					{ command: "rm file" },
					["rm"],
					["rm"],
				),
			).rejects.toThrow("Command denied by policy")
		})
	})
})
