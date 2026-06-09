import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockResolveCangjieToolPath,
	mockExistsSync,
	mockReadFileSync,
	mockWriteFileSync,
	mockReaddirSync,
	mockStatSync,
	mockUnlinkSync,
	mockExecFile,
} = vi.hoisted(() => ({
	mockResolveCangjieToolPath: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	mockReaddirSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockExecFile: vi.fn(),
}))

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
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	TextEdit: {
		replace: vi.fn().mockReturnValue({}),
	},
	OutputChannel: class {},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: mockExistsSync,
			readFileSync: mockReadFileSync,
			writeFileSync: mockWriteFileSync,
			readdirSync: mockReaddirSync,
			statSync: mockStatSync,
			unlinkSync: mockUnlinkSync,
		},
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
		writeFileSync: mockWriteFileSync,
		readdirSync: mockReaddirSync,
		statSync: mockStatSync,
		unlinkSync: mockUnlinkSync,
	}
})

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: mockResolveCangjieToolPath,
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

import { cleanupStaleCjfmtTempFiles, CjfmtFormatter } from "../CjfmtFormatter"

describe("CjfmtFormatter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockResolveCangjieToolPath.mockReturnValue(undefined)
		mockExistsSync.mockReturnValue(false)
	})

	describe("cleanupStaleCjfmtTempFiles", () => {
		it("does not throw when no temp files", () => {
			mockReaddirSync.mockReturnValue([])
			expect(() => cleanupStaleCjfmtTempFiles()).not.toThrow()
		})

		it("removes stale temp files", () => {
			mockReaddirSync.mockReturnValue(["cjfmt_old.txt", "other.txt", "cjfmt_recent.txt"])
			mockStatSync.mockImplementation((p: string) => {
				if (p.includes("cjfmt_old")) {
					return { isFile: () => true, mtimeMs: Date.now() - 10 * 60 * 1000 } // 10 min old
				}
				if (p.includes("cjfmt_recent")) {
					return { isFile: () => true, mtimeMs: Date.now() - 1000 } // 1 sec old
				}
				return { isFile: () => true, mtimeMs: Date.now() }
			})
			cleanupStaleCjfmtTempFiles()
			// Should only remove the old file
			expect(mockUnlinkSync).toHaveBeenCalledTimes(1)
		})
	})

	describe("CjfmtFormatter", () => {
		it("creates instance without throwing", () => {
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			expect(formatter).toBeDefined()
			formatter.dispose()
		})

		it("dispose does not throw", () => {
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			expect(() => formatter.dispose()).not.toThrow()
		})

		it("provideDocumentFormattingEdits returns empty when cjfmt not found", async () => {
			mockResolveCangjieToolPath.mockReturnValue(undefined)
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			const doc = {
				getText: () => "func main() {}",
				fileName: "/test/file.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
			const result = await formatter.provideDocumentFormattingEdits(
				doc,
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
			formatter.dispose()
		})

		it("provideDocumentFormattingEdits returns empty when content unchanged", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjfmt")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("func main() {}")
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			const doc = {
				getText: () => "func main() {}",
				fileName: "/test/file.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
			const result = await formatter.provideDocumentFormattingEdits(
				doc,
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
			formatter.dispose()
		})

		it("provideDocumentFormattingEdits returns TextEdit when content changed", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjfmt")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue('func main() {\n    println("hello")\n}')
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
					if (typeof cb === "function") cb(null, { stdout: "", stderr: "" })
				},
			)
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			const doc = {
				getText: () => 'func main() { println("hello") }',
				fileName: "/test/file.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
			const result = await formatter.provideDocumentFormattingEdits(
				doc,
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toHaveLength(1)
			formatter.dispose()
		})

		it("provideDocumentRangeFormattingEdits delegates to formatDocument", async () => {
			mockResolveCangjieToolPath.mockReturnValue(undefined)
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			const doc = {
				getText: () => "func main() {}",
				fileName: "/test/file.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
			const range = {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 15 },
			} as any
			const result = await formatter.provideDocumentRangeFormattingEdits(
				doc,
				range,
				{} as any,
				{ isCancellationRequested: false } as any,
			)
			expect(result).toEqual([])
			formatter.dispose()
		})

		it("returns empty when cancellation requested", async () => {
			mockResolveCangjieToolPath.mockReturnValue("/opt/cangjie/bin/cjfmt")
			const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() } as any
			const formatter = new CjfmtFormatter(mockOutput)
			const doc = {
				getText: () => "func main() {}",
				fileName: "/test/file.cj",
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			} as any
			const result = await formatter.provideDocumentFormattingEdits(
				doc,
				{} as any,
				{ isCancellationRequested: true } as any,
			)
			expect(result).toEqual([])
			formatter.dispose()
		})
	})
})
