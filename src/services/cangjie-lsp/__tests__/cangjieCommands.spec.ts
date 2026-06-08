import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showOpenDialog: vi.fn(),
		showTextDocument: vi.fn(),
		activeTextEditor: undefined,
		createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: vi.fn(),
		onDidSaveTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
	},
	commands: {
		registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		executeCommand: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
		parse: (s: string) => ({ fsPath: s, toString: () => s }),
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
	Selection: class {
		constructor(
			public anchor: unknown,
			public active: unknown,
		) {}
	},
	WorkspaceEdit: class {
		set() {}
		replace() {}
		insert() {}
		delete() {}
	},
	Location: class {
		constructor(
			public uri: unknown,
			public range: unknown,
		) {}
	},
	CodeAction: class {
		constructor(
			public title: string,
			public kind: unknown,
		) {}
	},
	CodeActionKind: {
		RefactorExtract: { value: "refactor.extract" },
		Refactor: { value: "refactor" },
	},
	OverviewRulerLane: { Right: 4 },
	SnippetString: class {
		constructor(public value: string) {}
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
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
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	formatCangjieToolchainReport: vi.fn().mockReturnValue("report"),
	probeCangjieToolchain: vi.fn().mockResolvedValue([]),
}))

vi.mock("../cangjieSourceLayout", () => ({
	inferCangjiePackageFromSrcLayout: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../cangjieGeneratedTestCleanup", () => ({
	registerGeneratedCangjieTestFile: vi.fn(),
	purgeAllTrackedCangjieTestFiles: vi.fn(),
}))

vi.mock("../../../core/prompts/sections/learnedFixesStorage", () => ({
	LEARNED_FIXES_FILE: "learned-fixes.json",
	ensureLearnedFixesFile: vi.fn(),
	getLearnedFixesJsonPath: vi.fn().mockReturnValue("/mock/learned-fixes.json"),
	loadLearnedFixes: vi.fn().mockReturnValue([]),
	saveLearnedFixes: vi.fn(),
}))

vi.mock("../../../core/prompts/sections/cangjie-context", () => ({
	invalidateCangjieContextSectionCache: vi.fn(),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

vi.mock("../../../shared/package", () => ({
	Package: { resolve: vi.fn().mockReturnValue(null) },
}))

import { registerCangjieCommands } from "../cangjieCommands"

describe("cangjieCommands", () => {
	it("registerCangjieCommands is a function", () => {
		expect(typeof registerCangjieCommands).toBe("function")
	})
})
