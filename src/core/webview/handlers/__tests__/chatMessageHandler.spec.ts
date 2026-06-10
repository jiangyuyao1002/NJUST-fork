import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock system boundaries
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("os", async (importOriginal) => ({
	...(await importOriginal<typeof import("os")>()),
}))

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}))

vi.mock("../../../../utils/export", () => ({
	resolveDefaultSaveUri: vi.fn(),
	saveLastExportPath: vi.fn(),
}))

const mockOpenFile = vi.fn()
vi.mock("../../../../integrations/misc/open-file", () => ({
	openFile: (...args: any[]) => mockOpenFile(...args),
}))

vi.mock("../../../../integrations/misc/image-handler", () => ({
	openImage: vi.fn(),
	saveImage: vi.fn(),
}))

vi.mock("../../../../integrations/misc/process-images", () => ({
	selectImages: vi.fn(),
}))

vi.mock("../../../../integrations/misc/select-context-files", () => ({
	selectContextFiles: vi.fn(),
}))

vi.mock("../../../../services/search/file-search", () => ({
	searchWorkspaceFiles: vi.fn(),
}))

vi.mock("../../../../utils/tts", () => ({
	playTts: vi.fn(),
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
	stopTts: vi.fn(),
}))

vi.mock("../../../../utils/git", () => ({
	searchCommits: vi.fn(),
}))

vi.mock("../../../../mentions", () => ({
	openMention: vi.fn(),
}))

vi.mock("../../../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn(),
}))

vi.mock("../../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn(),
}))

vi.mock("../../../generateSystemPrompt", () => ({
	generateSystemPrompt: vi.fn(),
}))

vi.mock("../../../../utils/openai-audio-transcription", () => ({
	getWhisperCredentialsFromProviderSettings: vi.fn(),
	transcribeWithOpenAiWhisper: vi.fn(),
}))

vi.mock("../../../messageEnhancer", () => ({
	MessageEnhancer: vi.fn(),
}))

vi.mock("../../../diagnosticsHandler", () => ({
	generateErrorDiagnostics: vi.fn(),
}))

vi.mock("../../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("./shared-utils", () => ({
	resolveIncomingImages: vi.fn(),
}))

import { MessageRouter } from "../MessageRouter"
import { registerChatHandlers } from "../chatMessageHandler"
import { isPathOutsideWorkspace } from "../../../../utils/pathUtils"

const mockedIsPathOutsideWorkspace = vi.mocked(isPathOutsideWorkspace)

function createMockContext() {
	return {
		provider: {
			postMessageToWebview: vi.fn(),
			say: vi.fn(),
			contextProxy: {} as any,
		} as any,
		getGlobalState: vi.fn(),
		updateGlobalState: vi.fn(),
		getCurrentCwd: () => "/workspace",
		getCurrentMode: vi.fn().mockResolvedValue("code"),
	}
}

describe("handleOpenFile security", () => {
	let router: MessageRouter

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		registerChatHandlers(router)
	})

	it("rejects paths outside workspace", async () => {
		mockedIsPathOutsideWorkspace.mockReturnValue(true)

		const context = createMockContext()
		const message = { type: "openFile" as const, text: "/etc/passwd" }

		await router.route(context, message)

		expect(mockOpenFile).not.toHaveBeenCalled()
	})

	it("allows paths inside workspace", async () => {
		mockedIsPathOutsideWorkspace.mockReturnValue(false)

		const context = createMockContext()
		const message = { type: "openFile" as const, text: "/workspace/src/file.ts" }

		await router.route(context, message)

		expect(mockOpenFile).toHaveBeenCalledWith("/workspace/src/file.ts", undefined)
	})

	it("resolves relative paths before checking", async () => {
		mockedIsPathOutsideWorkspace.mockReturnValue(true)

		const context = createMockContext()
		const message = { type: "openFile" as const, text: "../../etc/passwd" }

		await router.route(context, message)

		expect(mockOpenFile).not.toHaveBeenCalled()
	})
})
