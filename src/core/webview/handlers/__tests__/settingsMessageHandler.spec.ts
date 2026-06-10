import { describe, it, expect, vi, beforeEach } from "vitest"

const mockGetModels = vi.fn()
const mockListProviderModels = vi.fn()
const mockFlushModels = vi.fn()

vi.mock("../../../../api/providers/fetchers/modelCache", () => ({
	getModels: (...args: any[]) => mockGetModels(...args),
	listProviderModels: (...args: any[]) => mockListProviderModels(...args),
	flushModels: (...args: any[]) => mockFlushModels(...args),
}))

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("../../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("../../../../shared/logger", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock("../../../../shared/error-utils", () => ({
	getErrorMessage: vi.fn(),
}))

vi.mock("../../../../shared/package", () => ({
	Package: { name: "test" },
}))

vi.mock("../../../../shared/experiments", () => ({
	experimentDefault: {},
}))

vi.mock("../../config/importExport", () => ({
	importSettingsWithFeedback: vi.fn(),
	exportSettings: vi.fn(),
}))

vi.mock("../../../../utils/debugLog", () => ({
	debugLog: vi.fn(),
}))

vi.mock("../../../WebviewStateBuilder", () => ({
	clearOpenAiCodexAuthCache: vi.fn(),
}))

vi.mock("../../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		setShellIntegrationTimeout: vi.fn(),
		setShellIntegrationDisabled: vi.fn(),
		setCommandDelay: vi.fn(),
	},
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: {
		reportError: vi.fn(),
		captureEvent: vi.fn(),
	},
}))

import { MessageRouter } from "../MessageRouter"
import { registerSettingsHandlers } from "../settingsMessageHandler"

function createMockContext(apiConfiguration: Record<string, any> = {}) {
	return {
		provider: {
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue({ apiConfiguration }),
			contextProxy: {} as any,
		} as any,
		getGlobalState: vi.fn(),
		updateGlobalState: vi.fn(),
		getCurrentCwd: () => "/workspace",
		getCurrentMode: vi.fn().mockResolvedValue("code"),
	}
}

describe("settingsMessageHandler - requestRouterModels", () => {
	let router: MessageRouter

	beforeEach(() => {
		vi.clearAllMocks()
		router = new MessageRouter()
		registerSettingsHandlers(router)
		mockGetModels.mockResolvedValue({ "model-a": { maxTokens: 4096 } })
		mockListProviderModels.mockResolvedValue({
			"deepseek-v4-flash": { maxTokens: 8192, contextWindow: 64000 },
		})
		mockFlushModels.mockResolvedValue(undefined)
	})

	it("should include deepseek in candidates and route to listProviderModels", async () => {
		const context = createMockContext({
			deepSeekApiKey: "test-key",
			deepSeekBaseUrl: "https://api.deepseek.com",
		})

		const message = {
			type: "requestRouterModels" as const,
			values: { provider: "deepseek" },
		}

		await router.route(context, message)

		expect(mockListProviderModels).toHaveBeenCalledWith(
			"deepseek",
			expect.objectContaining({
				apiKey: "test-key",
				baseUrl: "https://api.deepseek.com",
			}),
		)

		expect(mockGetModels).not.toHaveBeenCalledWith(expect.objectContaining({ provider: "deepseek" }))
	})

	it("should post deepseek models to webview", async () => {
		const context = createMockContext({
			deepSeekApiKey: "test-key",
		})

		const message = {
			type: "requestRouterModels" as const,
			values: { provider: "deepseek" },
		}

		await router.route(context, message)

		const postCall = context.provider.postMessageToWebview.mock.calls.find(
			(call: any[]) => call[0]?.type === "routerModels",
		)
		expect(postCall).toBeDefined()
		expect(postCall![0].routerModels).toHaveProperty("deepseek")
		expect(postCall![0].values).toEqual({ provider: "deepseek" })
	})

	it("should route openrouter to getModels (not listProviderModels)", async () => {
		const context = createMockContext()

		const message = {
			type: "requestRouterModels" as const,
			values: { provider: "openrouter" },
		}

		await router.route(context, message)

		expect(mockGetModels).toHaveBeenCalledWith(expect.objectContaining({ provider: "openrouter" }))
		expect(mockListProviderModels).not.toHaveBeenCalled()
	})

	it("should handle deepseek fetch failure gracefully", async () => {
		mockListProviderModels.mockRejectedValue(new Error("API error"))

		const context = createMockContext({
			deepSeekApiKey: "test-key",
		})

		const message = {
			type: "requestRouterModels" as const,
			values: { provider: "deepseek" },
		}

		await router.route(context, message)

		const postCall = context.provider.postMessageToWebview.mock.calls.find(
			(call: any[]) => call[0]?.type === "routerModels",
		)
		expect(postCall).toBeDefined()
		expect(postCall![0].routerModels.deepseek).toEqual({})

		const errorCall = context.provider.postMessageToWebview.mock.calls.find(
			(call: any[]) => call[0]?.type === "singleRouterModelFetchResponse" && call[0]?.success === false,
		)
		expect(errorCall).toBeDefined()
	})

	it("should flush cache when refresh is true for deepseek", async () => {
		const context = createMockContext({
			deepSeekApiKey: "test-key",
		})

		const message = {
			type: "requestRouterModels" as const,
			values: { provider: "deepseek", refresh: true },
		}

		await router.route(context, message)

		expect(mockFlushModels).toHaveBeenCalled()
	})
})
