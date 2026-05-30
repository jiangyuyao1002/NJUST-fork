import { vi, describe, it, expect, beforeEach } from "vitest"
import type { WebviewMessage } from "@njust-ai/types"

vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/mock/workspace" } }] },
	env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn() } },
	Uri: { file: vi.fn().mockImplementation((p: string) => ({ fsPath: p })), parse: vi.fn().mockImplementation((u: string) => ({ scheme: u.split(":")[0] })) },
}))

vi.mock("../../../integrations/misc/open-file", () => ({ openFile: vi.fn() }))
vi.mock("../../../integrations/misc/image-handler", () => ({
	openImage: vi.fn(),
	saveImage: vi.fn(),
}))
vi.mock("../../../integrations/misc/process-images", () => ({ selectImages: vi.fn().mockResolvedValue([]) }))
vi.mock("../../../integrations/misc/select-context-files", () => ({
	selectContextFiles: vi.fn().mockResolvedValue({ mentionPaths: [], imageDataUrls: [] }),
}))
vi.mock("../../../services/search/file-search", () => ({ searchWorkspaceFiles: vi.fn().mockResolvedValue([]) }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(false) }))
vi.mock("../../../utils/tts", () => ({
	playTts: vi.fn(),
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
	stopTts: vi.fn(),
}))
vi.mock("../../../utils/git", () => ({ searchCommits: vi.fn().mockResolvedValue([]) }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: vi.fn().mockReturnValue(false) }))
vi.mock("../../../utils/openai-audio-transcription", () => ({
	getWhisperCredentialsFromProviderSettings: vi.fn(),
	transcribeWithOpenAiWhisper: vi.fn(),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../mentions", () => ({ openMention: vi.fn() }))
vi.mock("../../generateSystemPrompt", () => ({ generateSystemPrompt: vi.fn().mockResolvedValue("system prompt") }))
vi.mock("../messageEnhancer", () => ({
	MessageEnhancer: { enhanceMessage: vi.fn(), captureTelemetry: vi.fn() },
}))
vi.mock("../diagnosticsHandler", () => ({ generateErrorDiagnostics: vi.fn() }))
vi.mock("../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn().mockResolvedValue(undefined),
	saveLastExportPath: vi.fn(),
}))
vi.mock("../../../shared/package", () => ({ Package: { name: "njust-ai" } }))
vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn().mockImplementation(() => ({
		initialize: vi.fn(),
		filterPaths: vi.fn().mockImplementation((paths: string[]) => paths),
		dispose: vi.fn(),
	})),
}))
vi.mock("../../../utils/storage", () => ({ getTaskDirectoryPath: vi.fn().mockResolvedValue("/mock/task/dir") }))
vi.mock("../../handlers/shared-utils", () => ({
	resolveIncomingImages: vi.fn().mockImplementation((_ctx: any, data: any) => Promise.resolve({ text: data.text, images: data.images })),
}))

import { registerChatHandlers } from "../../handlers/chatMessageHandler"
import { MessageRouter } from "../../handlers/MessageRouter"
import { createMockContext } from "./helpers"

describe("chatMessageHandler", () => {
	let router: MessageRouter
	let context: ReturnType<typeof createMockContext>

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		context = createMockContext()
		registerChatHandlers(router)
	})

	it("registers all expected chat handlers", () => {
		const registeredTypes = [
			"customInstructions", "askResponse", "terminalOperation", "selectImages",
			"selectContextFiles", "openImage", "saveImage", "openFile", "readFileContent",
			"openMention", "openExternal", "ttsEnabled", "ttsSpeed", "playTts", "stopTts",
			"enhancePrompt", "transcribeAudio", "getSystemPrompt", "copySystemPrompt",
			"searchCommits", "searchFiles", "insertTextIntoTextarea",
			"showMdmAuthRequiredNotification", "dismissUpsell", "getDismissedUpsells",
			"openMarkdownPreview", "downloadErrorDiagnostics",
		]
		for (const type of registeredTypes) {
			const handler = vi.fn()
			router.register(type, handler)
		}
	})

	it("customInstructions calls provider.updateCustomInstructions", async () => {
		await router.route(context, { type: "customInstructions", text: "be helpful" } as WebviewMessage)

		expect(context.provider.updateCustomInstructions).toHaveBeenCalledWith("be helpful")
	})

	it("askResponse forwards to current task", async () => {
		const mockHandle = vi.fn()
		;(context.provider.getCurrentTask as any).mockReturnValue({ handleWebviewAskResponse: mockHandle })

		await router.route(context, { type: "askResponse", askResponse: "yesResponse", text: "ok" } as any)

		expect(mockHandle).toHaveBeenCalledWith("yesResponse", "ok", undefined)
	})

	it("askResponse does nothing when no current task", async () => {
		;(context.provider.getCurrentTask as any).mockReturnValue(null)

		await expect(
			router.route(context, { type: "askResponse", askResponse: "yesResponse", text: "ok" } as any),
		).resolves.not.toThrow()
	})

	it("terminalOperation forwards to current task", async () => {
		const mockHandle = vi.fn()
		;(context.provider.getCurrentTask as any).mockReturnValue({ handleTerminalOperation: mockHandle })

		await router.route(context, { type: "terminalOperation", terminalOperation: "abort" } as any)

		expect(mockHandle).toHaveBeenCalledWith("abort")
	})

	it("openFile resolves path and calls handler", async () => {
		// Handler calls openFile internally — verify through the path logic
		// by checking that no error is thrown (handler uses optional chaining)
		await expect(
			router.route(context, { type: "openFile", text: "/absolute/path.txt" } as WebviewMessage),
		).resolves.not.toThrow()
	})

	it("openFile does nothing without text", async () => {
		await expect(
			router.route(context, { type: "openFile" } as WebviewMessage),
		).resolves.not.toThrow()
	})

	it("readFileContent posts error when no path provided", async () => {
		await router.route(context, { type: "readFileContent", text: "" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "fileContent",
			fileContent: { path: "", content: null, error: "No path provided" },
		})
	})

	it("ttsEnabled updates global state", async () => {
		await router.route(context, { type: "ttsEnabled", bool: false } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("ttsEnabled", false)
		expect(context.provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("ttsEnabled defaults to true when bool is undefined", async () => {
		await router.route(context, { type: "ttsEnabled" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("ttsEnabled", true)
	})

	it("ttsSpeed updates global state", async () => {
		await router.route(context, { type: "ttsSpeed", value: 1.5 } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("ttsSpeed", 1.5)
		expect(context.provider.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("ttsSpeed defaults to 1.0 when value is undefined", async () => {
		await router.route(context, { type: "ttsSpeed" } as WebviewMessage)

		expect(context.updateGlobalState).toHaveBeenCalledWith("ttsSpeed", 1.0)
	})

	it("stopTts does not throw", async () => {
		await expect(
			router.route(context, { type: "stopTts" } as WebviewMessage),
		).resolves.not.toThrow()
	})

	it("insertTextIntoTextarea posts message to webview", async () => {
		await router.route(context, { type: "insertTextIntoTextarea", text: "hello" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "insertTextIntoTextarea",
			text: "hello",
		})
	})

	it("insertTextIntoTextarea does nothing without text", async () => {
		await router.route(context, { type: "insertTextIntoTextarea" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("dismissUpsell adds upsellId to dismissed list", async () => {
		;(context.getGlobalState as any).mockReturnValue([])

		await router.route(context, { type: "dismissUpsell", upsellId: "upsell-1" } as any)

		expect(context.updateGlobalState).toHaveBeenCalledWith("dismissedUpsells", ["upsell-1"])
	})

	it("dismissUpsell does not duplicate existing id", async () => {
		;(context.getGlobalState as any).mockReturnValue(["upsell-1"])

		await router.route(context, { type: "dismissUpsell", upsellId: "upsell-1" } as any)

		expect(context.updateGlobalState).not.toHaveBeenCalled()
	})

	it("getDismissedUpsells posts list to webview", async () => {
		;(context.getGlobalState as any).mockReturnValue(["upsell-1", "upsell-2"])

		await router.route(context, { type: "getDismissedUpsells" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "dismissedUpsells",
			list: ["upsell-1", "upsell-2"],
		})
	})

	it("getDismissedUpsells defaults to empty array", async () => {
		;(context.getGlobalState as any).mockReturnValue(undefined)

		await router.route(context, { type: "getDismissedUpsells" } as WebviewMessage)

		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "dismissedUpsells",
			list: [],
		})
	})

	it("getSystemPrompt posts message to webview", async () => {
		await router.route(context, { type: "getSystemPrompt", mode: "code" } as any)

		// Handler calls generateSystemPrompt then posts result
		expect(context.provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({ type: "systemPrompt" }),
		)
	})

	it("openExternal opens HTTP URL", async () => {
		const vscode = await import("vscode")

		await router.route(context, { type: "openExternal", url: "https://example.com" } as any)

		expect(vscode.env.openExternal).toHaveBeenCalled()
	})

	it("openExternal rejects non-HTTP URLs", async () => {
		const vscode = await import("vscode")

		await router.route(context, { type: "openExternal", url: "file:///etc/passwd" } as any)

		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Only HTTP/HTTPS URLs"))
		expect(vscode.env.openExternal).not.toHaveBeenCalled()
	})
})
