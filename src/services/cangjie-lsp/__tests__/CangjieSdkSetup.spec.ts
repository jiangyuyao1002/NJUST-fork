import { describe, it, expect, vi } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
		showOpenDialog: vi.fn(),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, _params?: Record<string, unknown>) => key,
}))

import { checkAndPromptSdkSetup } from "../CangjieSdkSetup"

describe("CangjieSdkSetup", () => {
	it("checkAndPromptSdkSetup is a function", () => {
		expect(typeof checkAndPromptSdkSetup).toBe("function")
	})
})
