// npx vitest core/prompts/services/__tests__/RuleFileManager.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("os", () => ({
	default: {
		homedir: () => "/home/user",
	},
	homedir: () => "/home/user",
}))

vi.mock("../../../../services/roo-config", () => ({
	getRooDirectoriesForCwd: vi.fn().mockImplementation((cwd: string) => {
		return [`/home/user/.njust_ai`, `${cwd}/.njust_ai`]
	}),
	getAllRooDirectoriesForCwd: vi.fn().mockImplementation(async (cwd: string) => {
		return [`/home/user/.njust_ai`, `${cwd}/.njust_ai`]
	}),
	getAgentsDirectoriesForCwd: vi.fn().mockImplementation(async (cwd: string) => {
		return [cwd]
	}),
}))

import path from "path"
import fs from "fs/promises"
import type { PathLike } from "fs"

import {
	safeReadFile,
	directoryExists,
	readTextFilesFromDirectory,
	formatDirectoryContent,
	shouldIncludeRuleFile,
	loadRuleFiles,
	readAgentRulesFile,
	loadAgentRulesFileFromDirectory,
	loadAllAgentRulesFiles,
	loadLearnedFixes,
	loadModeRules,
	loadGenericRules,
	loadAgentRulesIfEnabled,
} from "../RuleFileManager"

// Create mock functions
const readFileMock = vi.fn()
const statMock = vi.fn()
const readdirMock = vi.fn()
const readlinkMock = vi.fn()
const lstatMock = vi.fn()

// Replace fs functions with our mocks
fs.readFile = readFileMock as any
fs.stat = statMock as any
fs.readdir = readdirMock as any
fs.readlink = readlinkMock as any
fs.lstat = lstatMock as any

describe("RuleFileManager", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("safeReadFile", () => {
		it("should read and trim file content", async () => {
			readFileMock.mockResolvedValue("  content with spaces  ")
			const result = await safeReadFile("/fake/path")
			expect(result).toBe("content with spaces")
		})

		it("should return empty string on ENOENT", async () => {
			readFileMock.mockRejectedValue({ code: "ENOENT" })
			const result = await safeReadFile("/fake/path")
			expect(result).toBe("")
		})

		it("should return empty string on EISDIR", async () => {
			readFileMock.mockRejectedValue({ code: "EISDIR" })
			const result = await safeReadFile("/fake/path")
			expect(result).toBe("")
		})

		it("should throw on unexpected errors", async () => {
			const error = new Error("Permission denied") as NodeJS.ErrnoException
			error.code = "EPERM"
			readFileMock.mockRejectedValue(error)
			await expect(safeReadFile("/fake/path")).rejects.toThrow("Permission denied")
		})
	})

	describe("directoryExists", () => {
		it("should return true when directory exists", async () => {
			statMock.mockResolvedValue({ isDirectory: () => true })
			const result = await directoryExists("/fake/dir")
			expect(result).toBe(true)
		})

		it("should return false when path is a file", async () => {
			statMock.mockResolvedValue({ isDirectory: () => false })
			const result = await directoryExists("/fake/file")
			expect(result).toBe(false)
		})

		it("should return false when path does not exist", async () => {
			statMock.mockRejectedValue(new Error("ENOENT"))
			const result = await directoryExists("/fake/dir")
			expect(result).toBe(false)
		})
	})

	describe("shouldIncludeRuleFile", () => {
		it("should include normal files", () => {
			expect(shouldIncludeRuleFile("rules.md")).toBe(true)
			expect(shouldIncludeRuleFile("config.json")).toBe(true)
		})

		it("should exclude cache files", () => {
			expect(shouldIncludeRuleFile(".DS_Store")).toBe(false)
			expect(shouldIncludeRuleFile("Thumbs.db")).toBe(false)
			expect(shouldIncludeRuleFile("cache.log")).toBe(false)
			expect(shouldIncludeRuleFile("backup.bak")).toBe(false)
			expect(shouldIncludeRuleFile("temp.tmp")).toBe(false)
			expect(shouldIncludeRuleFile("script.pyc")).toBe(false)
			expect(shouldIncludeRuleFile("data.lock")).toBe(false)
			expect(shouldIncludeRuleFile("debug.dump")).toBe(false)
		})

		it("should handle paths with directories", () => {
			expect(shouldIncludeRuleFile("/path/to/rules.md")).toBe(true)
			expect(shouldIncludeRuleFile("/path/to/.DS_Store")).toBe(false)
		})
	})

	describe("readTextFilesFromDirectory", () => {
		it("should read all text files from directory", async () => {
			readdirMock.mockResolvedValueOnce([
				{
					name: "file1.txt",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
				{
					name: "file2.md",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
			] as any)

			statMock.mockImplementation((_path) => {
				return Promise.resolve({
					isFile: () => true,
					isDirectory: () => false,
				})
			})

			readFileMock.mockImplementation((filePath: PathLike) => {
				const pathStr = filePath.toString()
				if (pathStr.includes("file1.txt")) return Promise.resolve("content1")
				if (pathStr.includes("file2.md")) return Promise.resolve("content2")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await readTextFilesFromDirectory("/fake/path")

			expect(result).toHaveLength(2)
			expect(result[0]!.filename).toContain("file1.txt")
			expect(result[0]!.content).toBe("content1")
			expect(result[1]!.filename).toContain("file2.md")
			expect(result[1]!.content).toBe("content2")
		})

		it("should sort files alphabetically", async () => {
			readdirMock.mockResolvedValueOnce([
				{
					name: "zebra.txt",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
				{
					name: "alpha.txt",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
			] as any)

			statMock.mockImplementation(() =>
				Promise.resolve({
					isFile: () => true,
					isDirectory: () => false,
				}),
			)

			readFileMock.mockImplementation((filePath: PathLike) => {
				const pathStr = filePath.toString()
				if (pathStr.includes("zebra")) return Promise.resolve("zebra content")
				if (pathStr.includes("alpha")) return Promise.resolve("alpha content")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await readTextFilesFromDirectory("/fake/path")

			expect(result[0]!.content).toBe("alpha content")
			expect(result[1]!.content).toBe("zebra content")
		})

		it("should filter out cache files", async () => {
			readdirMock.mockResolvedValueOnce([
				{
					name: "rule.txt",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
				{
					name: ".DS_Store",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path",
				},
			] as any)

			statMock.mockImplementation(() =>
				Promise.resolve({
					isFile: () => true,
					isDirectory: () => false,
				}),
			)

			readFileMock.mockImplementation((filePath: PathLike) => {
				const pathStr = filePath.toString()
				if (pathStr.includes("rule.txt")) return Promise.resolve("rule content")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await readTextFilesFromDirectory("/fake/path")

			expect(result).toHaveLength(1)
			expect(result[0]!.content).toBe("rule content")
		})

		it("should handle directory read errors gracefully", async () => {
			readdirMock.mockRejectedValueOnce(new Error("Permission denied"))
			const result = await readTextFilesFromDirectory("/fake/path")
			expect(result).toEqual([])
		})
	})

	describe("formatDirectoryContent", () => {
		it("should format files with headers", () => {
			const files = [
				{ filename: "/project/rules/rule1.md", content: "rule 1" },
				{ filename: "/project/rules/rule2.md", content: "rule 2" },
			]
			const result = formatDirectoryContent(files, "/project")
			const relPath1 = path.relative("/project", "/project/rules/rule1.md")
			const relPath2 = path.relative("/project", "/project/rules/rule2.md")
			expect(result).toContain(`# Rules from ${relPath1}:`)
			expect(result).toContain("rule 1")
			expect(result).toContain(`# Rules from ${relPath2}:`)
			expect(result).toContain("rule 2")
		})

		it("should return empty string for empty array", () => {
			const result = formatDirectoryContent([], "/project")
			expect(result).toBe("")
		})
	})

	describe("loadRuleFiles", () => {
		it("should load rules from .njust_ai/rules/ when it exists", async () => {
			statMock.mockResolvedValueOnce({
				isDirectory: vi.fn().mockReturnValue(true),
			} as any)

			readdirMock.mockResolvedValueOnce([
				{
					name: "rule.md",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path/.njust_ai/rules",
				},
			] as any)

			statMock.mockImplementation(() =>
				Promise.resolve({
					isFile: () => true,
					isDirectory: () => false,
				}),
			)

			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("rule.md")) return Promise.resolve("rule content")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadRuleFiles("/fake/path")
			expect(result).toContain("rule content")
			expect(result).toContain("# Rules from")
		})

		it("should fall back to legacy .roorules when no rules directory exists", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes(".roorules")) return Promise.resolve("legacy rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadRuleFiles("/fake/path")
			expect(result).toContain("legacy rules")
			expect(result).toContain("# Rules from .roorules:")
		})

		it("should return empty string when no rules exist", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockRejectedValue({ code: "ENOENT" })

			const result = await loadRuleFiles("/fake/path")
			expect(result).toBe("")
		})
	})

	describe("readAgentRulesFile", () => {
		it("should read regular agent rules file", async () => {
			lstatMock.mockResolvedValueOnce({
				isSymbolicLink: () => false,
			} as any)
			readFileMock.mockResolvedValueOnce("agent rules content")

			const result = await readAgentRulesFile("/fake/path/AGENTS.md")
			expect(result).toBe("agent rules content")
		})

		it("should handle symlinks", async () => {
			lstatMock.mockResolvedValueOnce({
				isSymbolicLink: () => true,
			} as any)
			readlinkMock.mockResolvedValueOnce("../actual-agents.md")
			statMock.mockResolvedValueOnce({
				isFile: () => true,
				isDirectory: () => false,
			} as any)
			readFileMock.mockResolvedValueOnce("symlinked agent rules")

			const result = await readAgentRulesFile("/fake/path/AGENTS.md")
			expect(result).toBe("symlinked agent rules")
		})

		it("should return empty string when file does not exist", async () => {
			lstatMock.mockRejectedValueOnce(new Error("ENOENT"))
			const result = await readAgentRulesFile("/fake/path/AGENTS.md")
			expect(result).toBe("")
		})
	})

	describe("loadAgentRulesFileFromDirectory", () => {
		it("should load AGENTS.md from directory", async () => {
			lstatMock.mockResolvedValueOnce({
				isSymbolicLink: () => false,
			} as any)
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENTS.md")) return Promise.resolve("agent rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadAgentRulesFileFromDirectory("/fake/path", false)
			expect(result).toContain("Agent Rules Standard (AGENTS.md):")
			expect(result).toContain("agent rules")
		})

		it("should load AGENT.md when AGENTS.md doesn't exist", async () => {
			lstatMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENTS.md")) return Promise.reject({ code: "ENOENT" })
				if (filePath.toString().includes("AGENT.md"))
					return Promise.resolve({ isSymbolicLink: () => false })
				return Promise.reject({ code: "ENOENT" })
			})
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENT.md")) return Promise.resolve("agent rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadAgentRulesFileFromDirectory("/fake/path", false)
			expect(result).toContain("Agent Rules Standard (AGENT.md):")
			expect(result).toContain("agent rules")
		})

		it("should include AGENTS.local.md for personal overrides", async () => {
			lstatMock.mockResolvedValue({
				isSymbolicLink: () => false,
			} as any)
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENTS.local.md")) return Promise.resolve("local overrides")
				if (filePath.toString().includes("AGENTS.md")) return Promise.resolve("standard rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadAgentRulesFileFromDirectory("/fake/path", false)
			expect(result).toContain("standard rules")
			expect(result).toContain("local overrides")
		})
	})

	describe("loadAllAgentRulesFiles", () => {
		it("should load from root only when subfolder rules disabled", async () => {
			lstatMock.mockResolvedValueOnce({
				isSymbolicLink: () => false,
			} as any)
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENTS.md")) return Promise.resolve("root agent rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadAllAgentRulesFiles("/fake/path", false)
			expect(result).toContain("root agent rules")
		})
	})

	describe("loadLearnedFixes", () => {
		it("should return empty string when mode is empty", async () => {
			const result = await loadLearnedFixes("/fake/path", "")
			expect(result).toBe("")
		})

		it("should load summary and full fix files", async () => {
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("-summary.md")) return Promise.resolve("summary fixes")
				if (filePath.toString().includes("code.md")) return Promise.resolve("full fixes")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadLearnedFixes("/fake/path", "code")
			expect(result).toContain("summary fixes")
			expect(result).toContain("full fixes")
			expect(result).toContain("global: high-frequency summary")
			expect(result).toContain("project: full fix log")
		})

		it("should return empty string when no fixes exist", async () => {
			readFileMock.mockRejectedValue({ code: "ENOENT" })
			const result = await loadLearnedFixes("/fake/path", "code")
			expect(result).toBe("")
		})
	})

	describe("loadModeRules", () => {
		it("should load mode rules from directories", async () => {
			statMock.mockResolvedValueOnce({
				isDirectory: vi.fn().mockReturnValue(true),
			} as any)

			readdirMock.mockResolvedValueOnce([
				{
					name: "rule.txt",
					isFile: () => true,
					isSymbolicLink: () => false,
					parentPath: "/fake/path/.njust_ai/rules-test",
				},
			] as any)

			statMock.mockImplementation(() =>
				Promise.resolve({
					isFile: () => true,
					isDirectory: () => false,
				}),
			)

			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("rule.txt")) return Promise.resolve("mode rule content")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadModeRules("/fake/path", "test", false)
			expect(result.modeRuleContent).toContain("mode rule content")
			expect(result.usedRuleFile).toBe("rules-test directories")
		})

		it("should fall back to legacy .roorules-{mode} file", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes(".roorules-test")) return Promise.resolve("legacy mode rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadModeRules("/fake/path", "test", false)
			expect(result.modeRuleContent).toBe("legacy mode rules")
			expect(result.usedRuleFile).toBe(".roorules-test")
		})

		it("should fall back to .clinerules-{mode} when .roorules-{mode} doesn't exist", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes(".roorules-test")) return Promise.reject({ code: "ENOENT" })
				if (filePath.toString().includes(".clinerules-test")) return Promise.resolve("cline mode rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadModeRules("/fake/path", "test", false)
			expect(result.modeRuleContent).toBe("cline mode rules")
			expect(result.usedRuleFile).toBe(".clinerules-test")
		})
	})

	describe("loadGenericRules", () => {
		it("should load generic rules", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes(".roorules")) return Promise.resolve("generic rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadGenericRules("/fake/path", false)
			expect(result).toBe("# Rules from .roorules:\ngeneric rules")
		})

		it("should return empty string when no generic rules exist", async () => {
			statMock.mockRejectedValueOnce({ code: "ENOENT" })
			readFileMock.mockRejectedValue({ code: "ENOENT" })

			const result = await loadGenericRules("/fake/path", false)
			expect(result).toBe("")
		})
	})

	describe("loadAgentRulesIfEnabled", () => {
		it("should return empty string when disabled", async () => {
			const result = await loadAgentRulesIfEnabled("/fake/path", false, false)
			expect(result).toBe("")
		})

		it("should load agent rules when enabled", async () => {
			lstatMock.mockResolvedValueOnce({
				isSymbolicLink: () => false,
			} as any)
			readFileMock.mockImplementation((filePath: PathLike) => {
				if (filePath.toString().includes("AGENTS.md")) return Promise.resolve("agent rules")
				return Promise.reject({ code: "ENOENT" })
			})

			const result = await loadAgentRulesIfEnabled("/fake/path", false, true)
			expect(result).toContain("agent rules")
		})
	})
})
