import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExecFileAsync } = vi.hoisted(() => ({
	mockExecFileAsync: vi.fn(),
}))

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}))

vi.mock("util", () => ({
	promisify: () => mockExecFileAsync,
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("../safeUnlink", () => ({
	safeUnlink: vi.fn(),
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("crypto", () => ({
	default: { randomUUID: () => "test-uuid" },
	randomUUID: () => "test-uuid",
}))

vi.mock("os", () => ({
	default: { tmpdir: () => "/tmp" },
	tmpdir: () => "/tmp",
}))

vi.mock("path", async () => {
	const actual = await vi.importActual<typeof import("path")>("path")
	return { ...actual, default: actual }
})

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			readdirSync: vi.fn().mockReturnValue([]),
			statSync: vi.fn(),
			unlinkSync: vi.fn(),
			writeFileSync: vi.fn(),
			readFileSync: vi.fn(),
			existsSync: vi.fn().mockReturnValue(false),
		},
		readdirSync: vi.fn().mockReturnValue([]),
		statSync: vi.fn(),
		unlinkSync: vi.fn(),
		writeFileSync: vi.fn(),
		readFileSync: vi.fn(),
		existsSync: vi.fn().mockReturnValue(false),
	}
})

vi.mock("vscode", () => ({
	languages: {
		registerDocumentFormattingEditProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		registerDocumentRangeFormattingEditProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	window: {
		showErrorMessage: vi.fn(),
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	TextEdit: {
		replace: vi.fn().mockReturnValue({}),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p }),
	},
}))

import { cleanupStaleCjfmtTempFiles } from "../CjfmtFormatter"
import * as fs from "fs"
import { resolveCangjieToolPath } from "../cangjieToolUtils"
import { safeUnlink } from "../safeUnlink"

const mockFs = vi.mocked(fs)
const mockResolvePath = vi.mocked(resolveCangjieToolPath)
const mockSafeUnlink = vi.mocked(safeUnlink)

describe("CjfmtFormatter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFs.readdirSync.mockReturnValue([])
		mockFs.existsSync.mockReturnValue(false)
		mockResolvePath.mockReturnValue(undefined)
	})

	describe("cleanupStaleCjfmtTempFiles", () => {
		it("deletes old cjfmt_* files", () => {
			mockFs.readdirSync.mockReturnValue(["cjfmt_input_123.cj", "cjfmt_output_456.cj"] as any)
			mockFs.statSync.mockReturnValue({ isFile: () => true, mtimeMs: Date.now() - 10 * 60 * 1000 } as any)
			const log = { appendLine: vi.fn() }

			cleanupStaleCjfmtTempFiles(log as any)

			expect(mockFs.unlinkSync).toHaveBeenCalledTimes(2)
			expect(log.appendLine).toHaveBeenCalledTimes(2)
		})

		it("keeps recent cjfmt_* files", () => {
			mockFs.readdirSync.mockReturnValue(["cjfmt_input_123.cj"] as any)
			mockFs.statSync.mockReturnValue({ isFile: () => true, mtimeMs: Date.now() - 1000 } as any)

			cleanupStaleCjfmtTempFiles()

			expect(mockFs.unlinkSync).not.toHaveBeenCalled()
		})

		it("skips non-cjfmt files", () => {
			mockFs.readdirSync.mockReturnValue(["other_file.txt", "cjfmt_old.cj"] as any)
			mockFs.statSync.mockReturnValue({ isFile: () => true, mtimeMs: Date.now() - 10 * 60 * 1000 } as any)

			cleanupStaleCjfmtTempFiles()

			expect(mockFs.unlinkSync).toHaveBeenCalledTimes(1)
		})

		it("skips directories", () => {
			mockFs.readdirSync.mockReturnValue(["cjfmt_dir"] as any)
			mockFs.statSync.mockReturnValue({ isFile: () => false, mtimeMs: Date.now() - 10 * 60 * 1000 } as any)

			cleanupStaleCjfmtTempFiles()

			expect(mockFs.unlinkSync).not.toHaveBeenCalled()
		})

		it("handles stat errors gracefully", () => {
			mockFs.readdirSync.mockReturnValue(["cjfmt_bad.cj"] as any)
			mockFs.statSync.mockImplementation(() => {
				throw new Error("stat error")
			})

			expect(() => cleanupStaleCjfmtTempFiles()).not.toThrow()
		})

		it("handles readdirSync errors gracefully", () => {
			mockFs.readdirSync.mockImplementation(() => {
				throw new Error("readdir error")
			})

			expect(() => cleanupStaleCjfmtTempFiles()).not.toThrow()
		})

		it("uses 5-minute threshold for stale detection", () => {
			mockFs.readdirSync.mockReturnValue(["cjfmt_edge.cj"] as any)
			const fiveMinOneSec = 5 * 60 * 1000 + 1000
			mockFs.statSync.mockReturnValue({ isFile: () => true, mtimeMs: Date.now() - fiveMinOneSec } as any)

			cleanupStaleCjfmtTempFiles()

			expect(mockFs.unlinkSync).toHaveBeenCalledTimes(1)
		})
	})

	describe("CjfmtFormatter class", () => {
		it("creates instance without throwing", async () => {
			const { CjfmtFormatter } = await import("../CjfmtFormatter")
			const output = { appendLine: vi.fn(), dispose: vi.fn() }
			expect(() => new CjfmtFormatter(output as any)).not.toThrow()
		})

		it("dispose does not throw", async () => {
			const { CjfmtFormatter } = await import("../CjfmtFormatter")
			const output = { appendLine: vi.fn(), dispose: vi.fn() }
			const formatter = new CjfmtFormatter(output as any)
			expect(() => formatter.dispose()).not.toThrow()
		})
	})

	describe("provideDocumentFormattingEdits", () => {
		async function createFormatter() {
			const { CjfmtFormatter } = await import("../CjfmtFormatter")
			const output = { appendLine: vi.fn(), dispose: vi.fn() }
			return new CjfmtFormatter(output as any)
		}

		function makeDoc(content: string) {
			return {
				getText: () => content,
				fileName: "/ws/test.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
		}

		it("returns empty when cjfmt not found", async () => {
			mockResolvePath.mockReturnValue(undefined)
			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("hello"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
		})

		it("returns TextEdit when content changes", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
			mockFs.existsSync.mockReturnValue(true)
			mockFs.readFileSync.mockReturnValue("formatted content")

			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("original content"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result.length).toBe(1)
		})

		it("returns empty when content is same", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
			mockFs.existsSync.mockReturnValue(true)
			mockFs.readFileSync.mockReturnValue("same content")

			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("same content"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
		})

		it("returns empty when cancelled before exec", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("content"),
				{} as any,
				{ isCancellationRequested: true } as any,
			)
			expect(result).toEqual([])
		})

		it("returns empty when cancelled after exec", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			let cancelCallCount = 0
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })

			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("content"),
				{} as any,
				{
					get isCancellationRequested() {
						cancelCallCount++
						return cancelCallCount >= 2
					},
				} as any,
			)
			expect(result).toEqual([])
		})

		it("returns empty when no output file produced", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
			mockFs.existsSync.mockReturnValue(false)

			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("content"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
		})

		it("returns empty on execFile error", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockRejectedValue(new Error("exec failed"))

			const formatter = await createFormatter()
			const result = await formatter.provideDocumentFormattingEdits(
				makeDoc("content"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
		})

		it("calls safeUnlink in finally for both tmp files", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
			mockFs.existsSync.mockReturnValue(false)

			const formatter = await createFormatter()
			await formatter.provideDocumentFormattingEdits(
				makeDoc("content"),
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(mockSafeUnlink).toHaveBeenCalledTimes(2)
		})

		it("passes range lines to cjfmt args", async () => {
			mockResolvePath.mockReturnValue("/usr/bin/cjfmt")
			mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" })
			mockFs.existsSync.mockReturnValue(true)
			mockFs.readFileSync.mockReturnValue("formatted")

			const formatter = await createFormatter()
			await formatter.provideDocumentRangeFormattingEdits(
				makeDoc("content"),
				{ start: { line: 2 }, end: { line: 5 } } as any,
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(mockExecFileAsync).toHaveBeenCalledWith(
				"/usr/bin/cjfmt",
				expect.arrayContaining(["-l", "3:6"]),
				expect.anything(),
			)
		})
	})
})
