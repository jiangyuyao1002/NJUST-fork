import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	tasks: {
		registerTaskProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		fetchTasks: vi.fn().mockResolvedValue([]),
	},
	Task: class {
		constructor(
			public definition: unknown,
			public scope: unknown,
			public name: string,
			public source: string,
			public execution: unknown,
			public problemMatchers: string,
		) {
			this.group = undefined
			this.presentationOptions = {}
		}
		group: unknown
		presentationOptions: unknown
	},
	TaskDefinition: class {},
	TaskGroup: { Build: "build", Test: "test", Clean: "clean" },
	TaskRevealKind: { Always: 2 },
	TaskPanelKind: { Shared: 2 },
	ShellExecution: class {
		constructor(
			public command: string,
			public args: string[],
			public options: unknown,
		) {}
	},
	workspace: {
		workspaceFolders: [],
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
	},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: vi.fn().mockReturnValue(false) },
		existsSync: vi.fn().mockReturnValue(false),
	}
})

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
}))

import { CjpmTaskProvider } from "../CjpmTaskProvider"

describe("CjpmTaskProvider", () => {
	let provider: CjpmTaskProvider
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		provider = new CjpmTaskProvider(mockOutput)
	})

	describe("provideTasks", () => {
		it("returns empty when no workspace folders", async () => {
			const result = await provider.provideTasks()
			expect(result).toEqual([])
		})
	})

	describe("resolveTask", () => {
		it("returns undefined for non-cjpm task", () => {
			const task = { definition: { type: "other", command: "build" }, scope: undefined } as any
			const result = provider.resolveTask(task)
			expect(result).toBeUndefined()
		})

		it("returns undefined when no scope", () => {
			const task = { definition: { type: "cjpm", command: "build" }, scope: undefined } as any
			const result = provider.resolveTask(task)
			expect(result).toBeUndefined()
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => provider.dispose()).not.toThrow()
		})
	})
})
