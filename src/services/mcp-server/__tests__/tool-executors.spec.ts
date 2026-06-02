import { describe, it, expect, vi, afterEach } from "vitest"
import * as path from "path"
import * as fs from "fs/promises"
import { execCommand, execListFiles, execSearchFiles, execWriteFile, execApplyDiff } from "../tool-executors"
import { tmpdir } from "os"
import { mkdtemp, rm } from "fs/promises"

vi.mock("../../core/tools/helpers/commandSafety", () => ({
	checkCommandSafety: vi.fn(function () {
		return {
			riskLevel: "safe",
			reasons: [],
		}
	}),
}))

vi.mock("../../utils/env", () => ({
	filterSensitiveEnv: vi.fn(function () {
		return {}
	}),
}))

const { mockRegexSearchFiles, mockListFiles } = vi.hoisted(() => ({
	mockRegexSearchFiles: vi.fn(() => Promise.resolve("search results")),
	mockListFiles: vi.fn(() =>
		Promise.resolve([
			["/test/workspace/src/a.ts", "/test/workspace/src/b.ts", "/test/workspace/.rooignore/secret.ts"],
			false,
		]),
	),
}))

vi.mock("../../../services/ripgrep", () => ({
	regexSearchFiles: mockRegexSearchFiles,
}))

vi.mock("../../../services/glob/list-files", () => ({
	listFiles: mockListFiles,
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

			await expect(execCommand(workspaceCwd, { command: "npm install" }, ["git", "echo"])).rejects.toThrow(
				"Command requires explicit approval",
			)
		})

		it("allows command in allowed list", async () => {
			await setupDirs()

			const result = await execCommand(workspaceCwd, { command: "echo test" }, ["git", "echo"])

			expect(result).toContain("Exit code:")
		})

		it("allows any command when wildcard is present", async () => {
			await setupDirs()

			const result = await execCommand(workspaceCwd, { command: "node -e \"console.log('wildcard')\"" }, ["*"])

			expect(result).toContain("Exit code:")
		})

		it("matches command by base name", async () => {
			await setupDirs()

			const result = await execCommand(workspaceCwd, { command: "echo test" }, ["echo"])

			expect(result).toContain("Exit code:")
		})

		it("rejects command chain that includes denied command", async () => {
			await setupDirs()

			await expect(
				execCommand(workspaceCwd, { command: "git status && rm file" }, ["git"], ["rm"]),
			).rejects.toThrow("Command denied by policy")
		})
	})

	describe("deniedCommands enforcement", () => {
		it("rejects command in denied list", async () => {
			await setupDirs()

			await expect(execCommand(workspaceCwd, { command: "rm -rf /" }, ["*"], ["rm"])).rejects.toThrow(
				"Command denied by policy",
			)
		})

		it("deniedCommands checked after allowedCommands", async () => {
			await setupDirs()

			await expect(execCommand(workspaceCwd, { command: "rm file" }, ["rm"], ["rm"])).rejects.toThrow(
				"Command denied by policy",
			)
		})
	})
})

describe("execListFiles with rooIgnoreController", () => {
	let workspaceCwd: string
	let tempDir: string

	async function setupDirs() {
		tempDir = await mkdtemp(path.join(tmpdir(), "test-list-files-"))
		workspaceCwd = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceCwd, { recursive: true })
		await fs.mkdir(path.join(workspaceCwd, "src"), { recursive: true })
		await fs.writeFile(path.join(workspaceCwd, "src", "a.ts"), "content")
	}

	afterEach(async () => {
		mockListFiles.mockClear()
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	it("filters ignored files when rooIgnoreController is provided", async () => {
		await setupDirs()
		mockListFiles.mockResolvedValueOnce([
			[path.join(workspaceCwd, "src", "a.ts"), path.join(workspaceCwd, ".rooignore", "secret.ts")],
			false,
		])
		const rooIgnoreController = {
			validateAccess: vi.fn((relPath: string) => !relPath.includes(".rooignore")),
		}

		const result = await execListFiles(workspaceCwd, { path: "src" }, rooIgnoreController as any)

		expect(rooIgnoreController.validateAccess).toHaveBeenCalled()
		expect(result).not.toContain(".rooignore")
		expect(result).toContain("src/a.ts")
	})

	it("includes all files when rooIgnoreController is not provided", async () => {
		await setupDirs()
		mockListFiles.mockResolvedValueOnce([
			[path.join(workspaceCwd, "src", "a.ts"), path.join(workspaceCwd, "src", "b.ts")],
			false,
		])

		const result = await execListFiles(workspaceCwd, { path: "src" })

		expect(result).toBeTruthy()
	})
})

describe("execSearchFiles with rooIgnoreController", () => {
	let workspaceCwd: string
	let tempDir: string

	async function setupDirs() {
		tempDir = await mkdtemp(path.join(tmpdir(), "test-search-files-"))
		workspaceCwd = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceCwd, { recursive: true })
		await fs.mkdir(path.join(workspaceCwd, "src"), { recursive: true })
		await fs.writeFile(path.join(workspaceCwd, "src", "a.ts"), "content")
	}

	afterEach(async () => {
		mockRegexSearchFiles.mockClear()
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	it("passes rooIgnoreController to regexSearchFiles", async () => {
		await setupDirs()
		const rooIgnoreController = {
			validateAccess: vi.fn(() => true),
		}

		await execSearchFiles(workspaceCwd, { path: "src", regex: "test" }, rooIgnoreController as any)

		expect(mockRegexSearchFiles).toHaveBeenCalledWith(
			workspaceCwd,
			expect.any(String),
			"test",
			undefined,
			rooIgnoreController,
		)
	})

	it("works without rooIgnoreController", async () => {
		await setupDirs()

		await execSearchFiles(workspaceCwd, { path: "src", regex: "test" })

		expect(mockRegexSearchFiles).toHaveBeenCalledWith(
			workspaceCwd,
			expect.any(String),
			"test",
			undefined,
			undefined,
		)
	})
})

describe("symlink escape prevention", () => {
	let workspaceCwd: string
	let tempDir: string

	async function setupDirs() {
		tempDir = await mkdtemp(path.join(tmpdir(), "test-symlink-"))
		workspaceCwd = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceCwd, { recursive: true })
	}

	async function createSymlink(target: string, linkPath: string) {
		// Use junction on Windows (no admin required), dir symlink on Unix
		const type = process.platform === "win32" ? "junction" : "dir"
		await fs.symlink(target, linkPath, type)
	}

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true }).catch(() => {})
	})

	it("rejects write_file through symlink to outside directory", async () => {
		await setupDirs()
		const outsideDir = path.join(tempDir, "outside")
		await fs.mkdir(outsideDir, { recursive: true })
		const linkDir = path.join(workspaceCwd, "link")
		await createSymlink(outsideDir, linkDir)

		await expect(execWriteFile(workspaceCwd, { path: "link/new.txt", content: "escaped" })).rejects.toThrow(
			"Path escapes workspace boundary",
		)
	})

	it("rejects apply_diff through symlink to outside directory", async () => {
		await setupDirs()
		const outsideDir = path.join(tempDir, "outside")
		await fs.mkdir(outsideDir, { recursive: true })
		await fs.writeFile(path.join(outsideDir, "existing.txt"), "original", "utf-8")
		const linkDir = path.join(workspaceCwd, "link")
		await createSymlink(outsideDir, linkDir)

		await expect(
			execApplyDiff(workspaceCwd, {
				path: "link/existing.txt",
				diff: "--- original\n+++ modified\n@@ -1 +1 @@\n-original\n+escaped\n",
			}),
		).rejects.toThrow("Path escapes workspace boundary")
	})

	it("allows write_file in real subdirectory", async () => {
		await setupDirs()
		const realSubdir = path.join(workspaceCwd, "subdir")
		await fs.mkdir(realSubdir, { recursive: true })

		const result = await execWriteFile(workspaceCwd, { path: "subdir/new.txt", content: "safe" })

		expect(result).toContain("Created new file")
		const written = await fs.readFile(path.join(realSubdir, "new.txt"), "utf-8")
		expect(written).toBe("safe")
	})

	it("allows write_file in nested non-existent directories", async () => {
		await setupDirs()

		const result = await execWriteFile(workspaceCwd, { path: "newdir/subdir/new.txt", content: "nested" })

		expect(result).toContain("Created new file")
		const written = await fs.readFile(path.join(workspaceCwd, "newdir", "subdir", "new.txt"), "utf-8")
		expect(written).toBe("nested")
	})

	it("rejects write_file through symlink to outside directory with nested path", async () => {
		await setupDirs()
		const outsideDir = path.join(tempDir, "outside")
		await fs.mkdir(outsideDir, { recursive: true })
		const linkDir = path.join(workspaceCwd, "link")
		await createSymlink(outsideDir, linkDir)

		await expect(execWriteFile(workspaceCwd, { path: "link/newdir/new.txt", content: "escaped" })).rejects.toThrow(
			"Path escapes workspace boundary",
		)
	})
})
