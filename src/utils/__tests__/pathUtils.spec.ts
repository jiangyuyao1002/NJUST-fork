// npx vitest utils/__tests__/pathUtils.spec.ts

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as path from "path"
import * as fs from "fs/promises"
import { tmpdir } from "os"
import { mkdtemp, rm, symlink } from "fs/promises"

import { isPathOutsideWorkspace } from "../pathUtils"

// Mock vscode with a dynamic workspace folder that we can control per-test
let mockWorkspaceFolder: string | null = "/mock/workspace"

vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			if (mockWorkspaceFolder === null) {
				return []
			}
			return [{ uri: { fsPath: mockWorkspaceFolder } }]
		},
	},
}))

describe("isPathOutsideWorkspace symlink escape prevention", () => {
	let tempDir: string
	let workspaceDir: string

	beforeEach(() => {
		mockWorkspaceFolder = "/mock/workspace"
	})

	async function setupDirs() {
		tempDir = await mkdtemp(path.join(tmpdir(), "test-pathutils-"))
		workspaceDir = path.join(tempDir, "workspace")
		await fs.mkdir(workspaceDir, { recursive: true })
		mockWorkspaceFolder = workspaceDir
	}

	async function createSymlink(target: string, linkPath: string) {
		const type = process.platform === "win32" ? "junction" : "dir"
		await symlink(target, linkPath, type)
	}

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {})
		}
	})

	it("detects new file path through symlink to outside directory", async () => {
		await setupDirs()
		const outsideDir = path.join(tempDir, "outside")
		await fs.mkdir(outsideDir, { recursive: true })
		const linkDir = path.join(workspaceDir, "link")
		await createSymlink(outsideDir, linkDir)

		const newFilePath = path.join(linkDir, "new.txt")
		expect(isPathOutsideWorkspace(newFilePath)).toBe(true)
	})

	it("allows path in real subdirectory for new file", async () => {
		await setupDirs()
		const realSubdir = path.join(workspaceDir, "subdir")
		await fs.mkdir(realSubdir, { recursive: true })

		const newFilePath = path.join(realSubdir, "new.txt")
		expect(isPathOutsideWorkspace(newFilePath)).toBe(false)
	})

	it("allows path where intermediate parent directories do not exist", async () => {
		await setupDirs()
		// workspaceDir exists, but newdir/subdir do not.
		const deepPath = path.join(workspaceDir, "newdir", "subdir", "new.txt")
		expect(isPathOutsideWorkspace(deepPath)).toBe(false)
	})

	it("allows existing file inside workspace", async () => {
		await setupDirs()
		const existingFile = path.join(workspaceDir, "existing.txt")
		await fs.writeFile(existingFile, "content", "utf-8")

		expect(isPathOutsideWorkspace(existingFile)).toBe(false)
	})

	it("detects existing symlink file pointing outside workspace", async () => {
		await setupDirs()
		const outsideFile = path.join(tempDir, "outside.txt")
		await fs.writeFile(outsideFile, "secret", "utf-8")

		// On Windows file symlinks need admin; skip this test on Windows
		if (process.platform === "win32") {
			return
		}

		const linkFile = path.join(workspaceDir, "link.txt")
		await symlink(outsideFile, linkFile, "file")

		expect(isPathOutsideWorkspace(linkFile)).toBe(true)
	})

	it("returns true when no workspace folders exist", () => {
		mockWorkspaceFolder = null
		expect(isPathOutsideWorkspace("/any/path")).toBe(true)
	})
})
