import { describe, expect, it, vi } from "vitest"

import type { ProviderSettings } from "@njust-ai-cj/types"

import { Task } from "../Task"
import { TaskEventBus } from "../../events/TaskEventBus"

function createHost(storagePath: string) {
	return {
		context: {
			globalStorageUri: { fsPath: storagePath },
			globalState: { get: vi.fn(), update: vi.fn() },
			workspaceState: { get: vi.fn(), update: vi.fn() },
			secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
			subscriptions: [],
		},
		contextProxy: {
			globalStorageUri: { fsPath: storagePath },
			extensionUri: { fsPath: storagePath },
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn(),
			setValue: vi.fn(),
		},
		cwd: storagePath,
		getState: vi.fn().mockResolvedValue({
			mode: "code",
			currentApiConfigName: "default",
			mcpEnabled: false,
			apiConfiguration: { apiProvider: "anthropic" },
		}),
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue([]),
		getMcpHub: vi.fn(),
		getSkillsManager: vi.fn(),
		delegateParentAndOpenChild: vi.fn(),
		setMode: vi.fn(),
		setProviderProfile: vi.fn(),
		handleModeSwitch: vi.fn(),
		cancelTask: vi.fn(),
		getTaskStackSize: vi.fn().mockReturnValue(1),
		convertToWebviewUri: vi.fn((filePath: string) => filePath),
		ensureMcpServersDirectoryExists: vi.fn(),
		ensureSettingsDirectoryExists: vi.fn(),
		getExtensionPackageVersion: vi.fn().mockReturnValue("test"),
	} as any
}

describe("Task Node isolation", () => {
	it("instantiates and requests assistant presentation without VS Code/webview mocks", async () => {
		const eventBus = new TaskEventBus()
		const seen: string[] = []
		eventBus.on("task:assistant-message-requested", async (_event, payload) => {
			seen.push(payload.taskId ?? "")
		})

		const apiConfiguration: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		const task = new Task({
			host: createHost("D:/tmp/roo-node-isolation"),
			apiConfiguration,
			eventBus,
			startTask: false,
		})

		await task.waitForModeInitialization()
		await task.presentAssistantMessage()

		expect(seen).toEqual([task.taskId])
		expect(task.diffViewProvider.isEditing).toBe(false)
	})
})
