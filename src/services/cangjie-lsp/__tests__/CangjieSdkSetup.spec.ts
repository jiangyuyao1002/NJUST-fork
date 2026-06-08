import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockExistsSync,
	mockShowInformationMessage,
	mockShowWarningMessage,
	mockShowOpenDialog,
	mockGet,
	mockConfigUpdate,
	mockExecuteCommand,
	mockOpenExternal,
	mockExecFile,
} = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockShowInformationMessage: vi.fn(),
	mockShowWarningMessage: vi.fn(),
	mockShowOpenDialog: vi.fn(),
	mockGet: vi.fn(),
	mockConfigUpdate: vi.fn(),
	mockExecuteCommand: vi.fn(),
	mockOpenExternal: vi.fn(),
	mockExecFile: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
		showOpenDialog: mockShowOpenDialog,
		showInformationMessage: mockShowInformationMessage,
		showWarningMessage: mockShowWarningMessage,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: vi.fn(),
		getConfiguration: vi.fn().mockReturnValue({
			get: mockGet,
			update: mockConfigUpdate,
		}),
	},
	commands: {
		executeCommand: mockExecuteCommand,
	},
	env: {
		openExternal: mockOpenExternal,
	},
	Uri: {
		file: (p: string) => ({ fsPath: p }),
		parse: (s: string) => ({ fsPath: s }),
	},
	ConfigurationTarget: { Global: 1 },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync },
		existsSync: mockExistsSync,
	}
})

vi.mock("child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("../cangjieToolUtils", () => ({
	resolveCangjieToolPath: vi.fn().mockReturnValue(undefined),
	buildCangjieToolEnv: vi.fn().mockReturnValue({}),
	detectCangjieHome: vi.fn().mockReturnValue(undefined),
	formatCangjieToolchainSummaryLine: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../../i18n", () => ({
	t: (key: string, _params?: Record<string, unknown>) => key,
}))

vi.mock("../../../shared/package", () => ({
	Package: { name: "njust-ai" },
}))

import { checkAndPromptSdkSetup } from "../CangjieSdkSetup"
import { detectCangjieHome } from "../cangjieToolUtils"

describe("CangjieSdkSetup", () => {
	let mockContext: any
	let mockOutput: any

	beforeEach(() => {
		vi.clearAllMocks()

		const globalStateStore: Record<string, unknown> = {}
		mockContext = {
			globalState: {
				get: vi.fn((key: string) => globalStateStore[key]),
				update: vi.fn((key: string, value: unknown) => {
					globalStateStore[key] = value
				}),
			},
		}
		mockOutput = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}

		// Default: getConfiguration returns empty serverPath, existsSync returns false
		mockGet.mockReturnValue("")
		mockExistsSync.mockReturnValue(false)
		// Default: showInformationMessage returns a resolved Promise
		mockShowInformationMessage.mockResolvedValue(undefined)
		mockShowWarningMessage.mockResolvedValue(undefined)
		// Default: execFile calls callback with stdout
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
			if (typeof cb === "function") cb(null, { stdout: "1.0.0\n" })
		})
	})

	it("returns early when configuredServerPath exists and file exists", async () => {
		mockGet.mockImplementation((key: string) => {
			if (key === "cangjieLsp.serverPath") return "/opt/cangjie/bin/LSPServer"
			return ""
		})
		mockExistsSync.mockReturnValue(true)

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		// Should return without showing detection prompt
		expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
			expect.stringContaining("cangjie_sdk_detected"),
			expect.anything(),
		)
	})

	it("shows quick start nudge on first run when serverPath exists", async () => {
		mockGet.mockImplementation((key: string) => {
			if (key === "cangjieLsp.serverPath") return "/opt/cangjie/bin/LSPServer"
			return ""
		})
		mockExistsSync.mockReturnValue(true)

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockContext.globalState.update).toHaveBeenCalledWith("cangjie.quickStartNudgeShown", true)
	})

	it("returns early when dismissed", async () => {
		mockContext.globalState.get = vi.fn((key: string) => {
			if (key === "cangjie.sdkSetupDismissed") return true
			return undefined
		})
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		// Should not show any warning about SDK not detected
		expect(mockShowWarningMessage).not.toHaveBeenCalled()
	})

	it("shows detection prompt when SDK is detected", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
		mockShowInformationMessage.mockResolvedValue(undefined) // user dismisses

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockShowInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("cangjie_sdk_detected"),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})

	it("auto-configures SDK when user chooses Yes", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
		mockShowInformationMessage.mockResolvedValue("answers.yes")
		mockExistsSync.mockImplementation((p: string) => {
			if (p.includes("LSPServer")) return true
			return false
		})

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockConfigUpdate).toHaveBeenCalledWith(
			"cangjieLsp.serverPath",
			expect.stringContaining("LSPServer"),
			expect.anything(),
		)
		expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("Auto-configured SDK"))
	})

	it("sets dismissed flag when user chooses Dismiss", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue("/opt/cangjie")
		mockShowInformationMessage.mockResolvedValue("buttons.dismiss")

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockContext.globalState.update).toHaveBeenCalledWith("cangjie.sdkSetupDismissed", true)
	})

	it("shows warning when SDK is not detected", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValue(undefined)

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockShowWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("cangjie_sdk_not_detected"),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})

	it("opens download URL when user chooses Download", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValue("buttons.download_sdk")

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockOpenExternal).toHaveBeenCalled()
	})

	it("sets dismissed flag when user chooses Later (no SDK detected)", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValue("buttons.later")

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockContext.globalState.update).toHaveBeenCalledWith("cangjie.sdkSetupDismissed", true)
	})

	it("prompts manual select when user chooses select_sdk_dir", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValue("buttons.select_sdk_dir")
		mockShowOpenDialog.mockResolvedValue(undefined) // user cancels dialog

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockShowOpenDialog).toHaveBeenCalled()
	})

	it("configures SDK on manual select with valid path", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValue("buttons.select_sdk_dir")
		mockShowOpenDialog.mockResolvedValue([{ fsPath: "/manual/sdk" }])
		mockExistsSync.mockImplementation((p: string) => {
			if (p.includes("cjc")) return true
			if (p.includes("LSPServer")) return true
			return false
		})

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		expect(mockConfigUpdate).toHaveBeenCalled()
		expect(mockOutput.appendLine).toHaveBeenCalledWith(expect.stringContaining("SDK configured"))
	})

	it("shows reselect prompt when manual select has invalid path", async () => {
		vi.mocked(detectCangjieHome).mockReturnValue(undefined)
		mockShowWarningMessage.mockResolvedValueOnce("buttons.select_sdk_dir")
		mockShowOpenDialog.mockResolvedValue([{ fsPath: "/invalid/sdk" }])
		// cjc does not exist
		mockExistsSync.mockReturnValue(false)
		// execFile throws for invalid path
		mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: (...args: any[]) => void) => {
			if (typeof cb === "function") cb(new Error("not found"))
		})
		// User cancels reselect
		mockShowWarningMessage.mockResolvedValueOnce("buttons.cancel")

		await checkAndPromptSdkSetup(mockContext, mockOutput)

		// Should show warning about cjc not found
		expect(mockShowWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("cangjie_cjc_not_found"),
			expect.anything(),
			expect.anything(),
		)
	})
})
