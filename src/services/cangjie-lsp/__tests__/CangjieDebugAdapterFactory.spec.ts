import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	debug: {
		registerDebugAdapterDescriptorFactory: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		registerDebugConfigurationProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		}),
	},
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showErrorMessage: vi.fn(),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn().mockReturnValue(false),
			statSync: vi.fn().mockReturnValue({ isFile: () => false, isDirectory: () => false }),
			readdirSync: vi.fn().mockReturnValue([]),
		},
		existsSync: vi.fn().mockReturnValue(false),
		statSync: vi.fn().mockReturnValue({ isFile: () => false, isDirectory: () => false }),
		readdirSync: vi.fn().mockReturnValue([]),
	}
})

vi.mock("../cangjieToolUtils", () => ({
	detectCangjieHome: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../shared/package", () => ({
	Package: { resolve: vi.fn().mockReturnValue(null) },
}))

vi.mock("../../../shared/error-utils", () => ({
	getErrorMessage: (e: unknown) => String(e),
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieDebugAdapterFactory, CangjieDebugConfigurationProvider } from "../CangjieDebugAdapterFactory"

describe("CangjieDebugAdapterFactory", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("CangjieDebugConfigurationProvider is a class", () => {
		expect(typeof CangjieDebugConfigurationProvider).toBe("function")
	})

	it("CangjieDebugAdapterFactory is a class", () => {
		expect(typeof CangjieDebugAdapterFactory).toBe("function")
	})
})
