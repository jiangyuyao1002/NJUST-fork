import * as path from "path"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const { mockExistsSync, mockReadFileSync, mockGetConfiguration, mockExecFile } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockGetConfiguration: vi.fn(),
	mockExecFile: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn(), dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		getConfiguration: mockGetConfiguration,
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync },
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
	}
})

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("../../../shared/package", () => ({
	Package: { name: "njust-ai" },
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn() },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

import * as vscodeModule from "vscode"
import {
	invalidateCangjieToolEnvCache,
	detectCangjieHome,
	buildCangjieToolEnv,
	resolveCangjieToolPath,
	formatCangjieToolchainReport,
	probeCangjieToolchain,
	autoDetectPackageDeclaration,
	formatCangjieToolchainSummaryLine,
	CJC_CONFIG_KEY,
} from "../cangjieToolUtils"

/**
 * Helper: on Windows path.resolve adds a drive letter (e.g. "D:\ws") while
 * path.join does not ("\ws"). The source function autoDetectPackageDeclaration
 * uses path.join for srcRoot but path.resolve for absFile, so both must share
 * the same base.  We resolve the mock workspace fsPath to include the drive
 * letter so that path.join(srcRoot) and path.resolve(filePath) are consistent.
 */
const WS = path.resolve("/ws")

describe("cangjieToolUtils", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		invalidateCangjieToolEnvCache()
		mockGetConfiguration.mockReturnValue({
			get: vi.fn().mockReturnValue(""),
		})
		mockExistsSync.mockReturnValue(false)
	})

	afterEach(() => {
		invalidateCangjieToolEnvCache()
	})

	describe("CJC_CONFIG_KEY", () => {
		it("is cangjieLsp.cjcPath", () => {
			expect(CJC_CONFIG_KEY).toBe("cangjieLsp.cjcPath")
		})
	})

	// ---------------------------------------------------------------------------
	// autoDetectPackageDeclaration
	// ---------------------------------------------------------------------------

	describe("autoDetectPackageDeclaration", () => {
		it("returns null when workspaceFolders is empty", () => {
			const origFolders = (vscodeModule.workspace as any).workspaceFolders
			;(vscodeModule.workspace as any).workspaceFolders = []

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBeNull()
			;(vscodeModule.workspace as any).workspaceFolders = origFolders
		})

		it("returns null when workspaceFolders is undefined", () => {
			const origFolders = (vscodeModule.workspace as any).workspaceFolders
			;(vscodeModule.workspace as any).workspaceFolders = undefined

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBeNull()
			;(vscodeModule.workspace as any).workspaceFolders = origFolders
		})

		it("returns null when cjpm.toml does not exist", () => {
			mockExistsSync.mockReturnValue(false)
			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBeNull()
		})

		it("uses project name from cjpm.toml and default src-dir for root file", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "myproject"\n')

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBe("myproject")
		})

		it("uses custom src-dir from cjpm.toml", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "myproject"\nsrc-dir = "lib"\n')

			const result = autoDetectPackageDeclaration(path.join(WS, "lib", "main.cj"))
			expect(result).toBe("myproject")
		})

		it("returns null when file is outside src root", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "myproject"\n')

			const result = autoDetectPackageDeclaration(path.join(WS, "tests", "test.cj"))
			expect(result).toBeNull()
		})

		it("returns dotted package path for sub-package", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "myproject"\n')

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "utils", "helper.cj"))
			expect(result).toBe("myproject.utils")
		})

		it("returns deeply nested dotted package path", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "myproject"\n')

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "a", "b", "c", "deep.cj"))
			expect(result).toBe("myproject.a.b.c")
		})

		it("uses 'default' as root name when cjpm.toml has no name field", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("[source]\n")

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBe("default")
		})

		it("returns null on readFileSync error (catch block)", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockImplementation(() => {
				throw new Error("read error")
			})

			const result = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(result).toBeNull()
		})

		it("uses default src-dir 'src' when src-dir is not in toml", () => {
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('name = "proj"\n')

			// File in src root -> returns just the root name
			const rootResult = autoDetectPackageDeclaration(path.join(WS, "src", "main.cj"))
			expect(rootResult).toBe("proj")

			// File in a subdirectory of src -> returns dotted path
			const subResult = autoDetectPackageDeclaration(path.join(WS, "src", "pkg", "file.cj"))
			expect(subResult).toBe("proj.pkg")
		})
	})

	// ---------------------------------------------------------------------------
	// detectCangjieHome
	// ---------------------------------------------------------------------------

	describe("detectCangjieHome", () => {
		it("returns CANGJIE_HOME from environment when set and exists", () => {
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => p === "/opt/cangjie")

			const result = detectCangjieHome()
			expect(result).toBe("/opt/cangjie")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("returns undefined when no CANGJIE_HOME and no well-known paths", () => {
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)

			const result = detectCangjieHome()
			expect(result).toBeUndefined()
		})

		it("returns well-known path when exists", () => {
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockImplementation((p: string) => {
				return p.includes("cangjie") && p.endsWith("bin")
			})

			const result = detectCangjieHome()
			expect(result).toBeDefined()
		})

		it("returns cached value on second call without re-checking filesystem", () => {
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => p === "/opt/cangjie")

			const result1 = detectCangjieHome()
			expect(result1).toBe("/opt/cangjie")

			mockExistsSync.mockReset()
			const result2 = detectCangjieHome()
			expect(result2).toBe("/opt/cangjie")
			// Cached result should not trigger additional existsSync calls
			expect(mockExistsSync).not.toHaveBeenCalled()

			process.env.CANGJIE_HOME = originalEnv
		})

		it("infers home from VS Code LSP serverPath config", () => {
			delete process.env.CANGJIE_HOME
			const configGet = vi.fn().mockReturnValue("/opt/cangjie/lsp/server/bin/cjc-langserver")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps.includes("/opt/cangjie/lsp/server/bin") || ps === "/opt/cangjie/lsp/server/bin"
			})

			const result = detectCangjieHome()
			expect(result).toBeDefined()
			expect(result).toContain("cangjie")
		})

		it("falls through to well-known paths when serverPath exists but sdkRoot/bin does not", () => {
			delete process.env.CANGJIE_HOME
			const configGet = vi.fn().mockReturnValue("/some/other/path/bin/server")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				// serverPath exists
				if (ps === "/some/other/path/bin/server") return true
				// A well-known path has bin
				if (p.includes("cangjie") && p.endsWith("bin")) return true
				return false
			})

			const result = detectCangjieHome()
			expect(result).toBeDefined()
		})

		it("skips LSP inference when serverPath config is empty", () => {
			delete process.env.CANGJIE_HOME
			const configGet = vi.fn().mockReturnValue("")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockImplementation((p: string) => {
				return p.includes("cangjie") && p.endsWith("bin")
			})

			const result = detectCangjieHome()
			// Should reach the well-known paths check
			expect(result).toBeDefined()
		})

		it("skips CANGJIE_HOME when env is set but path does not exist", () => {
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/nonexistent/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				return p.includes("cangjie") && p.endsWith("bin") && !String(p).includes("nonexistent")
			})

			const result = detectCangjieHome()
			// Should skip CANGJIE_HOME and fall through to well-known paths
			expect(result).toBeDefined()

			process.env.CANGJIE_HOME = originalEnv
		})
	})

	// ---------------------------------------------------------------------------
	// buildCangjieToolEnv
	// ---------------------------------------------------------------------------

	describe("buildCangjieToolEnv", () => {
		it("returns process.env when no cangjieHome", () => {
			invalidateCangjieToolEnvCache()
			mockExistsSync.mockReturnValue(false)
			delete process.env.CANGJIE_HOME

			const env = buildCangjieToolEnv()
			expect(env).toBeDefined()
			expect(env.PATH || env.Path).toBeDefined()
		})

		it("sets CANGJIE_HOME when provided", () => {
			invalidateCangjieToolEnvCache()
			mockExistsSync.mockReturnValue(false)

			const env = buildCangjieToolEnv("/opt/cangjie")
			expect(env.CANGJIE_HOME).toBe("/opt/cangjie")
		})

		it("adds extra paths to PATH when they exist", () => {
			invalidateCangjieToolEnvCache()
			mockExistsSync.mockReturnValue(true)

			const env = buildCangjieToolEnv("/opt/cangjie")
			const pathValue = env.PATH || env.Path
			// Should contain the cangjie home path (platform-specific separator)
			expect(pathValue).toBeDefined()
		})

		it("returns cached env on subsequent calls with the same key", () => {
			invalidateCangjieToolEnvCache()
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => p === "/opt/cangjie")

			const env1 = buildCangjieToolEnv()
			mockExistsSync.mockReset()

			// Same home should return cached result
			const env2 = buildCangjieToolEnv("/opt/cangjie")
			expect(env2.CANGJIE_HOME).toBe(env1.CANGJIE_HOME)
			// No additional filesystem checks should have been made
			expect(mockExistsSync).not.toHaveBeenCalled()

			process.env.CANGJIE_HOME = originalEnv
		})

		it("sets LD_LIBRARY_PATH on non-win32 platform", () => {
			invalidateCangjieToolEnvCache()
			const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux" })

			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps.includes("/opt/cangjie/runtime/lib/linux") || ps.includes("/opt/cangjie/lib/linux")
			})

			try {
				const env = buildCangjieToolEnv("/opt/cangjie")
				expect(env.LD_LIBRARY_PATH).toBeDefined()
				expect(env.LD_LIBRARY_PATH).toContain("linux_x86_64_llvm")
				// Should use colon separator on non-Windows
				expect(env.LD_LIBRARY_PATH).not.toContain(";")
			} finally {
				if (origPlatform) {
					Object.defineProperty(process, "platform", origPlatform)
				}
				process.env.CANGJIE_HOME = originalEnv
			}
		})

		it("uses win32-specific paths and does not set LD_LIBRARY_PATH", () => {
			invalidateCangjieToolEnvCache()
			const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "win32" })

			mockExistsSync.mockReturnValue(true)

			try {
				const env = buildCangjieToolEnv("C:\\cangjie")
				const pathValue = env.PATH || env.Path
				expect(pathValue).toBeDefined()
				expect(pathValue).toContain("windows_x86_64_llvm")
				// LD_LIBRARY_PATH should NOT be set on Windows
				expect(env.LD_LIBRARY_PATH).toBeUndefined()
			} finally {
				if (origPlatform) {
					Object.defineProperty(process, "platform", origPlatform)
				}
			}
		})

		it("updates an existing PATH key when building win32 environment", () => {
			invalidateCangjieToolEnvCache()
			const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			const origEnv = Object.getOwnPropertyDescriptor(process, "env")
			Object.defineProperty(process, "platform", { value: "win32" })
			Object.defineProperty(process, "env", {
				value: { PATH: "C:\\existing-bin" },
				configurable: true,
				writable: true,
			})

			mockExistsSync.mockReturnValue(true)

			try {
				const env = buildCangjieToolEnv("C:\\cangjie")
				expect(env.PATH).toContain("windows_x86_64_llvm")
				expect(env.Path).toContain("windows_x86_64_llvm")
				expect(env.LD_LIBRARY_PATH).toBeUndefined()
			} finally {
				if (origPlatform) {
					Object.defineProperty(process, "platform", origPlatform)
				}
				if (origEnv) {
					Object.defineProperty(process, "env", origEnv)
				}
			}
		})

		it("preserves existing LD_LIBRARY_PATH content on non-win32", () => {
			invalidateCangjieToolEnvCache()
			const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux" })

			const origLd = process.env.LD_LIBRARY_PATH
			process.env.LD_LIBRARY_PATH = "/existing/lib"

			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps.includes("/opt/cangjie/runtime/lib/linux") || ps.includes("/opt/cangjie/lib/linux")
			})

			try {
				const env = buildCangjieToolEnv("/opt/cangjie")
				expect(env.LD_LIBRARY_PATH).toContain("/existing/lib")
				expect(env.LD_LIBRARY_PATH).toContain("linux_x86_64_llvm")
			} finally {
				if (origPlatform) {
					Object.defineProperty(process, "platform", origPlatform)
				}
				if (origLd !== undefined) {
					process.env.LD_LIBRARY_PATH = origLd
				} else {
					delete process.env.LD_LIBRARY_PATH
				}
				process.env.CANGJIE_HOME = originalEnv
			}
		})

		it("does not set LD_LIBRARY_PATH when no extra paths exist on non-win32", () => {
			invalidateCangjieToolEnvCache()
			const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
			Object.defineProperty(process, "platform", { value: "linux" })

			const origLd = process.env.LD_LIBRARY_PATH
			delete process.env.LD_LIBRARY_PATH
			mockExistsSync.mockReturnValue(false)

			try {
				const env = buildCangjieToolEnv("/opt/cangjie")
				// No extra paths exist, so LD_LIBRARY_PATH should not be set
				expect(env.LD_LIBRARY_PATH).toBeUndefined()
			} finally {
				if (origPlatform) {
					Object.defineProperty(process, "platform", origPlatform)
				}
				if (origLd !== undefined) {
					process.env.LD_LIBRARY_PATH = origLd
				}
			}
		})
	})

	// ---------------------------------------------------------------------------
	// resolveCangjieToolPath
	// ---------------------------------------------------------------------------

	describe("resolveCangjieToolPath", () => {
		it("returns configured path when valid", () => {
			const configGet = vi.fn().mockReturnValue("/opt/cangjie/bin/cjc")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockReturnValue(true)

			const result = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY)
			// path.resolve normalizes the path
			expect(result).toBeDefined()
		})

		it("returns undefined when configured path does not exist", () => {
			const configGet = vi.fn().mockReturnValue("/nonexistent/cjc")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockReturnValue(false)

			const result = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY)
			expect(result).toBeUndefined()
		})

		it("returns bare executable name when nothing found and no config", () => {
			const configGet = vi.fn().mockReturnValue("")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)

			const result = resolveCangjieToolPath("cjc")
			expect(result).toBeDefined()
			// Should return the executable name (platform-specific)
			expect(result).toMatch(/cjc/)
		})

		it("finds tool in CANGJIE_HOME bin directory", () => {
			const configGet = vi.fn().mockReturnValue("")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})

			const result = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY)
			expect(result).toBeDefined()
			expect(result).toContain("bin")
			expect(result).toContain("cjc")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("falls back to tools/bin when not found in bin", () => {
			const configGet = vi.fn().mockReturnValue("")
			mockGetConfiguration.mockReturnValue({ get: configGet })
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("tools/bin/")
			})

			const result = resolveCangjieToolPath("cjfmt")
			expect(result).toBeDefined()
			expect(result).toContain("tools")
			expect(result).toContain("cjfmt")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("skips config lookup when no configKey provided", () => {
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})

			// No configKey -> skip config check entirely
			const result = resolveCangjieToolPath("cjpm")
			expect(result).toBeDefined()
			expect(result).toContain("cjpm")

			process.env.CANGJIE_HOME = originalEnv
		})
	})

	// ---------------------------------------------------------------------------
	// formatCangjieToolchainReport
	// ---------------------------------------------------------------------------

	describe("formatCangjieToolchainReport", () => {
		it("formats successful probes", () => {
			const probes = [
				{
					id: "cjc" as const,
					label: "cjc",
					invokedPath: "/opt/cangjie/bin/cjc",
					ok: true,
					versionLine: "1.0.0",
				},
			]
			const report = formatCangjieToolchainReport(probes)
			expect(report).toContain("Cangjie")
			expect(report).toContain("\u2713 cjc")
			expect(report).toContain("1.0.0")
		})

		it("formats failed probes", () => {
			const probes = [
				{ id: "cjc" as const, label: "cjc", invokedPath: "/nonexistent", ok: false, hint: "not found" },
			]
			const report = formatCangjieToolchainReport(probes)
			expect(report).toContain("\u2717 cjc")
			expect(report).toContain("not found")
		})

		it("includes configKey when present", () => {
			const probes = [
				{
					id: "cjc" as const,
					label: "cjc",
					configKey: "cangjieTools.cjcPath",
					invokedPath: "/opt/cjc",
					ok: true,
					versionLine: "1.0",
				},
			]
			const report = formatCangjieToolchainReport(probes)
			expect(report).toContain("[cangjieTools.cjcPath]")
		})

		it("shows default hint text when no hint provided for failed probe", () => {
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)

			const probes = [{ id: "cjc" as const, label: "cjc", invokedPath: "/opt/cjc", ok: false }]
			const report = formatCangjieToolchainReport(probes)
			// Default fallback text in the source is the Chinese characters for "unavailable"
			expect(report).toContain("\u4e0d\u53ef\u7528")
		})

		it("shows CANGJIE_HOME fallback message when not detected", () => {
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)

			const probes = [{ id: "cjc" as const, label: "cjc", invokedPath: "cjc", ok: false, hint: "fail" }]
			const report = formatCangjieToolchainReport(probes)
			expect(report).toContain("CANGJIE_HOME")
			// When not detected, shows the "not detected" message
			expect(report).toContain("\u672a\u68c0\u6d4b\u5230")
		})

		it("includes detected CANGJIE_HOME path in header when found", () => {
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => p === "/opt/cangjie")

			const probes = [
				{ id: "cjc" as const, label: "cjc", invokedPath: "/opt/cangjie/bin/cjc", ok: true, versionLine: "1.0" },
			]
			const report = formatCangjieToolchainReport(probes)
			expect(report).toContain("/opt/cangjie")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("formats probes without configKey without brackets", () => {
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)

			const probes = [{ id: "cjc" as const, label: "cjc", invokedPath: "cjc", ok: true, versionLine: "v1" }]
			const report = formatCangjieToolchainReport(probes)
			// No configKey -> no brackets
			expect(report).not.toContain("[")
			expect(report).toContain("\u2713 cjc: v1")
		})
	})

	// ---------------------------------------------------------------------------
	// probeCangjieToolchain
	// ---------------------------------------------------------------------------

	describe("probeCangjieToolchain", () => {
		it("returns probe results for all tools", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(new Error("not found"))
				},
			)

			const results = await probeCangjieToolchain()
			expect(results).toHaveLength(4)
			expect(results.map((r) => r.id)).toEqual(["cjc", "cjpm", "cjfmt", "cjlint"])
		})

		it("marks tool as ok when version succeeds", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => p.includes("bin/cjc"))
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "Cangjie 1.0.0", stderr: "" })
				},
			)

			const results = await probeCangjieToolchain()
			const cjcResult = results.find((r) => r.id === "cjc")
			expect(cjcResult?.ok).toBe(true)
			expect(cjcResult?.versionLine).toContain("Cangjie")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("reports 'not found' when tool looks configured but resolved path is undefined", async () => {
			const configGet = vi.fn().mockImplementation((key: string) => {
				if (key === CJC_CONFIG_KEY) return "/nonexistent/cjc"
				return ""
			})
			mockGetConfiguration.mockReturnValue({ get: configGet })
			mockExistsSync.mockReturnValue(false)
			delete process.env.CANGJIE_HOME

			const results = await probeCangjieToolchain()
			const cjcResult = results.find((r) => r.id === "cjc")
			expect(cjcResult?.ok).toBe(false)
			expect(cjcResult?.hint).toContain(CJC_CONFIG_KEY)
		})

		it("tries fallback probe args when first arg fails (cjlint)", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)
			mockExecFile.mockImplementation((cmd: string, args: string[], _opts: any, cb: (...args: any[]) => void) => {
				const cmdStr = String(cmd)
				if (cmdStr.includes("cjlint") && args[0] === "--version") {
					if (typeof cb === "function") cb(new Error("unknown flag"))
				} else if (cmdStr.includes("cjlint") && args[0] === "-V") {
					if (typeof cb === "function") cb(null, { stdout: "cjlint 2.0", stderr: "" })
				} else {
					if (typeof cb === "function") cb(new Error("not found"))
				}
			})

			const results = await probeCangjieToolchain()
			const cjlintResult = results.find((r) => r.id === "cjlint")
			expect(cjlintResult?.ok).toBe(true)
			expect(cjlintResult?.versionLine).toContain("cjlint")
		})

		it("reports failure when all probe args fail for a tool", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(new Error("all probes failed"))
				},
			)

			const results = await probeCangjieToolchain()
			for (const r of results) {
				expect(r.ok).toBe(false)
				expect(r.hint).toBeDefined()
			}
		})

		it("marks all tools as ok when all probes succeed", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "v1.0.0", stderr: "" })
				},
			)

			const results = await probeCangjieToolchain()
			expect(results.every((r) => r.ok)).toBe(true)
			for (const r of results) {
				expect(r.versionLine).toBeDefined()
			}

			process.env.CANGJIE_HOME = originalEnv
		})

		it("uses '(no output)' as versionLine when tool produces empty stdout and stderr", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)

			const results = await probeCangjieToolchain()
			const cjcResult = results.find((r) => r.id === "cjc")
			expect(cjcResult?.ok).toBe(true)
			expect(cjcResult?.versionLine).toBe("(no output)")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("combines stdout and stderr for version info", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "Cangjie 3.0", stderr: "build 123" })
				},
			)

			const results = await probeCangjieToolchain()
			const cjcResult = results.find((r) => r.id === "cjc")
			expect(cjcResult?.ok).toBe(true)
			// First non-empty line from combined stdout+stderr
			expect(cjcResult?.versionLine).toContain("Cangjie 3.0")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("truncates error hint to 200 characters", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)
			const longError = new Error("x".repeat(300))
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(longError)
				},
			)

			const results = await probeCangjieToolchain()
			for (const r of results) {
				expect(r.ok).toBe(false)
				// hint is msg.slice(0, 200) so should be at most 200 chars
				expect((r.hint || "").length).toBeLessThanOrEqual(200)
			}
		})
	})

	// ---------------------------------------------------------------------------
	// formatCangjieToolchainSummaryLine
	// ---------------------------------------------------------------------------

	describe("formatCangjieToolchainSummaryLine", () => {
		it("returns a string with missing tools when some probes fail", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			delete process.env.CANGJIE_HOME
			mockExistsSync.mockReturnValue(false)
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(new Error("not found"))
				},
			)

			const result = await formatCangjieToolchainSummaryLine()
			expect(typeof result).toBe("string")
			expect(result).toContain("Cangjie")
			// Some tools should be failing, so it mentions missing tools
			expect(result).toContain("\u7f3a\u5931")
		})

		it("returns success message with version when all tools pass", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "Cangjie 1.0.0", stderr: "" })
				},
			)

			const result = await formatCangjieToolchainSummaryLine()
			expect(result).toContain("Cangjie SDK \u5df2\u5c31\u7eea")
			expect(result).toContain("Cangjie 1.0.0")
			// All tools should have checkmarks
			expect(result).toContain("\u2713")
			expect(result).not.toContain("\u7f3a\u5931")

			process.env.CANGJIE_HOME = originalEnv
		})

		it("returns success message without explicit version when cjc has (no output)", async () => {
			mockGetConfiguration.mockReturnValue({
				get: vi.fn().mockReturnValue(""),
			})
			const originalEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/opt/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				const ps = String(p).replace(/\\/g, "/")
				return ps === "/opt/cangjie" || ps.includes("/opt/cangjie/bin/")
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)

			const result = await formatCangjieToolchainSummaryLine()
			expect(result).toContain("Cangjie SDK \u5df2\u5c31\u7eea")
			// versionLine is "(no output)" which is truthy, so it appears in the message
			expect(result).toContain("(no output)")
			expect(result).toContain("\u2713")

			process.env.CANGJIE_HOME = originalEnv
		})
	})
})
