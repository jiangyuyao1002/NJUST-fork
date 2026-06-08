import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		createFileSystemWatcher: vi.fn().mockReturnValue({
			onDidChange: vi.fn(),
			onDidCreate: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		}),
	},
	RelativePattern: class {
		constructor(
			public base: unknown,
			public pattern: string,
		) {}
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
		default: { ...actual, existsSync: vi.fn().mockReturnValue(false), watch: vi.fn() },
		existsSync: vi.fn().mockReturnValue(false),
		watch: vi.fn(),
	}
})

vi.mock("@njust-ai/types", () => ({
	NJUST_AI_CONFIG_DIR: ".njust_ai",
}))

vi.mock("../njust-ai-config", () => ({
	getGlobalRooDirectory: vi.fn().mockReturnValue("/mock/global"),
}))

vi.mock("../../../core/prompts/sections/cangjie-context", () => ({
	invalidateCangjieContextSectionCache: vi.fn(),
}))

import { registerCangjieRulesHotReload } from "../cangjieRulesHotReload"

describe("cangjieRulesHotReload", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("registerCangjieRulesHotReload is a function", () => {
		expect(typeof registerCangjieRulesHotReload).toBe("function")
	})

	it("registers without throwing", () => {
		const mockContext = { subscriptions: [] as any[] }
		const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		expect(() => registerCangjieRulesHotReload(mockContext as any, mockOutput as any)).not.toThrow()
	})

	it("adds dispose to subscriptions", () => {
		const mockContext = { subscriptions: [] as any[] }
		const mockOutput = { appendLine: vi.fn(), dispose: vi.fn() }
		registerCangjieRulesHotReload(mockContext as any, mockOutput as any)
		expect(mockContext.subscriptions.length).toBe(1)
	})
})
