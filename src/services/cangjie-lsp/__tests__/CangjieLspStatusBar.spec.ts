import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createStatusBarItem: vi.fn().mockReturnValue({
			text: "",
			tooltip: "",
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
			command: "",
			backgroundColor: undefined,
		}),
		onDidChangeActiveTextEditor: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		activeTextEditor: undefined,
	},
	commands: {
		registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	CJC_CONFIG_KEY: "cangjieTools.cjcPath",
}))

vi.mock("child_process", () => ({
	execFile: vi.fn(),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import * as vscode from "vscode"
import { CangjieLspStatusBar } from "../CangjieLspStatusBar"

function createMockLspClient(state = "idle") {
	return {
		state,
		onStateChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	} as any
}

describe("CangjieLspStatusBar", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("creates status bar items on construction", () => {
		const client = createMockLspClient()
		const output = { show: vi.fn(), dispose: vi.fn() }
		const buildOutput = { show: vi.fn(), dispose: vi.fn() }
		new CangjieLspStatusBar(client, output as any, buildOutput as any)
		expect(vscode.window.createStatusBarItem).toHaveBeenCalledTimes(2)
	})

	it("registers commands on construction", () => {
		const client = createMockLspClient()
		const output = { show: vi.fn(), dispose: vi.fn() }
		const buildOutput = { show: vi.fn(), dispose: vi.fn() }
		new CangjieLspStatusBar(client, output as any, buildOutput as any)
		expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(2)
	})

	it("dispose cleans up resources", () => {
		const client = createMockLspClient()
		const output = { show: vi.fn(), dispose: vi.fn() }
		const buildOutput = { show: vi.fn(), dispose: vi.fn() }
		const status = new CangjieLspStatusBar(client, output as any, buildOutput as any)
		expect(() => status.dispose()).not.toThrow()
	})
})
