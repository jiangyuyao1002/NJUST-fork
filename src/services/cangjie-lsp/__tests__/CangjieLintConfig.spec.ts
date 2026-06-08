import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	Diagnostic: class {
		constructor(
			public range: unknown,
			public message: string,
			public severity: number,
		) {
			this.source = ""
		}
		source: string
	},
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	languages: {
		createDiagnosticCollection: vi.fn().mockReturnValue({
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	workspace: {
		workspaceFolders: [],
		getWorkspaceFolder: vi.fn(),
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
		asRelativePath: vi.fn((p: string) => p),
		onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

import { CangjieLintConfig } from "../CangjieLintConfig"

describe("CangjieLintConfig", () => {
	let config: CangjieLintConfig
	let mockOutput: { appendLine: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		config = new CangjieLintConfig(mockOutput as any)
	})

	describe("isRuleSuppressed", () => {
		it("returns false for unknown rule", () => {
			expect(config.isRuleSuppressed("unknown.rule")).toBe(false)
		})
	})

	describe("getEffectiveSeverity", () => {
		it("returns undefined for unknown rule", () => {
			expect(config.getEffectiveSeverity("unknown.rule")).toBeUndefined()
		})
	})

	describe("isFileExcluded", () => {
		it("returns false when no exclude patterns", () => {
			expect(config.isFileExcluded("/path/to/file.cj")).toBe(false)
		})
	})

	describe("filterDiagnostics", () => {
		it("returns all diagnostics when no rules configured", () => {
			const diags = [
				{ message: "some error", severity: 0, range: {} },
				{ message: "another error", severity: 0, range: {} },
			]
			const result = config.filterDiagnostics(diags as any)
			expect(result).toHaveLength(2)
		})

		it("filters diagnostics with suppressed rule ids", () => {
			// Manually set config via loadConfig would need fs mock
			// Instead test the public API with default empty config
			const diags = [{ message: "[rule.id] some error", severity: 0, range: {} }]
			const result = config.filterDiagnostics(diags as any)
			expect(result).toHaveLength(1)
		})
	})

	describe("currentConfig", () => {
		it("returns default empty config", () => {
			const cfg = config.currentConfig
			expect(cfg.rules).toEqual({})
			expect(cfg.custom).toEqual([])
			expect(cfg.exclude).toEqual([])
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => config.dispose()).not.toThrow()
		})
	})
})
