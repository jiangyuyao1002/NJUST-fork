import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn(),
	getDefaultEnvironment: vi.fn().mockReturnValue({ PATH: "/usr/bin" }),
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn(),
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock("reconnecting-eventsource", () => ({
	default: vi.fn(),
}))

import { appendErrorMessageToConnection, connectToServerWithHub } from "../McpHubConnection"
import {
	deleteServerWithHub,
	readServerConfigFromFileWithHub,
	toggleServerDisabledWithHub,
	updateServerConfigWithHub,
	updateServerTimeoutWithHub,
} from "../McpHubConfigPersistence"
import {
	fetchResourcesListWithHub,
	fetchToolsListWithHub,
	toggleToolAlwaysAllowWithHub,
	toggleToolEnabledForPromptWithHub,
	updateServerToolListWithHub,
} from "../McpHubToolPermissions"

describe("McpHub extraction boundaries", () => {
	it("exposes connection helpers", () => {
		expect(typeof connectToServerWithHub).toBe("function")
		expect(typeof appendErrorMessageToConnection).toBe("function")
	})

	it("exposes config persistence helpers", () => {
		expect(typeof toggleServerDisabledWithHub).toBe("function")
		expect(typeof readServerConfigFromFileWithHub).toBe("function")
		expect(typeof updateServerConfigWithHub).toBe("function")
		expect(typeof updateServerTimeoutWithHub).toBe("function")
		expect(typeof deleteServerWithHub).toBe("function")
	})

	it("exposes tool permission helpers", () => {
		expect(typeof fetchToolsListWithHub).toBe("function")
		expect(typeof fetchResourcesListWithHub).toBe("function")
		expect(typeof updateServerToolListWithHub).toBe("function")
		expect(typeof toggleToolAlwaysAllowWithHub).toBe("function")
		expect(typeof toggleToolEnabledForPromptWithHub).toBe("function")
	})
})
