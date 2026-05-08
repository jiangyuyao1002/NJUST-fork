import { beforeEach, describe, expect, it, vi } from "vitest"

import { ClineProvider } from "../ClineProvider"
import { Task } from "../../task/Task"
import type { ExtensionContext, OutputChannel } from "vscode"
import type { ProviderSettings, HistoryItem } from "@njust-ai-cj/types"

// Mock dependencies
vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	return {
		workspace: {
			getConfiguration: vi.fn(() => ({
				get: vi.fn().mockReturnValue([]),
				update: vi.fn().mockResolvedValue(undefined),
			})),
			workspaceFolders: [],
			onDidChangeConfiguration: vi.fn(() => mockDisposable),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => ({
			event: vi.fn(),
			fire: vi.fn(),
		})),
		Disposable: {
			from: vi.fn(),
		},
		window: {
			showErrorMessage: vi.fn(),
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			onDidChangeActiveTextEditor: vi.fn(() => mockDisposable),
		},
		Uri: {
			file: vi.fn().mockReturnValue({ toString: () => "file://test" }),
		},
	}
})

vi.mock("../../task/Task")
vi.mock("../../config/ContextProxy")
vi.mock("../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({
			registerClient: vi.fn(),
		}),
		unregisterProvider: vi.fn(),
	},
}))
vi.mock("../../../integrations/workspace/WorkspaceTracker")
vi.mock("../../config/ProviderSettingsManager")
vi.mock("../../config/CustomModesManager")
vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
}))

// Mock TelemetryService
vi.mock("@njust-ai-cj/telemetry", () => ({
	TelemetryService: {
		instance: {
			setProvider: vi.fn(),
			captureTaskCreated: vi.fn(),
		},
	},
}))

vi.mock("../../../shared/embeddingModels", () => ({
	EMBEDDING_MODEL_PROFILES: [],
}))

interface MockTask {
	taskId: string
	instanceId: string
	emit: ReturnType<typeof vi.fn>
	abortTask?: ReturnType<typeof vi.fn>
	abandoned?: boolean
	dispose?: ReturnType<typeof vi.fn>
	on: ReturnType<typeof vi.fn>
	off: ReturnType<typeof vi.fn>
}

describe("ClineProvider flicker-free cancel", () => {
	let provider: ClineProvider
	let mockContext: ExtensionContext
	let mockOutputChannel: OutputChannel
	let mockTask1: MockTask
	let mockTask2: MockTask

	const mockApiConfig: ProviderSettings = {
		apiProvider: "anthropic",
		apiKey: "test-key",
	} as ProviderSettings

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock extension context
		mockContext = {
			globalState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: "/test/storage" },
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			extensionUri: { fsPath: "/test/extension" },
			extensionPath: "/test/extension",
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
		} as unknown as ExtensionContext

		// Setup mock output channel
		mockOutputChannel = {
			appendLine: vi.fn(),
			dispose: vi.fn(),
		} as unknown as OutputChannel

		// Setup mock context proxy
		const mockContextProxy = {
			getValues: vi.fn().mockReturnValue({}),
			getValue: vi.fn().mockReturnValue(undefined),
			setValue: vi.fn().mockResolvedValue(undefined),
			getProviderSettings: vi.fn().mockReturnValue(mockApiConfig),
			extensionUri: mockContext.extensionUri,
			globalStorageUri: mockContext.globalStorageUri,
		}

		// Create provider instance
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", mockContextProxy as any)

		// Mock provider methods
		provider.getState = vi.fn().mockResolvedValue({
			apiConfiguration: mockApiConfig,
			mode: "code",
		})

		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		// Mock private method using any cast
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(provider as any).updateGlobalState = vi.fn().mockResolvedValue(undefined)
		provider.activateProviderProfile = vi.fn().mockResolvedValue(undefined)
		provider.performPreparationTasks = vi.fn().mockResolvedValue(undefined)
		provider.getTaskWithId = vi.fn().mockImplementation((id) =>
			Promise.resolve({
				historyItem: {
					id,
					number: 1,
					ts: Date.now(),
					task: "test task",
					tokensIn: 100,
					tokensOut: 200,
					totalCost: 0.001,
					workspace: "/test/workspace",
				},
			}),
		)

		// Setup mock tasks
		mockTask1 = {
			taskId: "task-1",
			instanceId: "instance-1",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			abandoned: false,
			dispose: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		mockTask2 = {
			taskId: "task-1", // Same ID for rehydration scenario
			instanceId: "instance-2", // Different instance
			emit: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}

		// Mock Task constructor
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		vi.mocked(Task).mockImplementation(() => mockTask2 as any)
	})

	it("should not remove current task from stack when rehydrating same taskId", async () => {
		// Setup: Add a task to the stack first
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await provider.stack.push(mockTask1 as any)

		// Spy on stack.pop to verify it's NOT called (rehydration path)
		const popSpy = vi.spyOn(provider.stack, "pop")

		// Create history item with same taskId as current task
		const historyItem: HistoryItem = {
			id: "task-1", // Same as mockTask1.taskId
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Create task with history item (should rehydrate in-place)
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: pop should NOT be called
		expect(popSpy).not.toHaveBeenCalled()

		// Verify the task was replaced in-place via rehydrate
		expect(provider.stack.size).toBe(1)
		expect(provider.stack.current).toBe(mockTask2)

		// Verify new task received focus event
		expect(mockTask2.emit).toHaveBeenCalledWith("taskFocused")
	})

	it("should remove task from stack when creating different task", async () => {
		// Setup: Add a task to the stack first
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await provider.stack.push(mockTask1 as any)

		// Spy on stack.pop to verify it IS called
		const popSpy = vi.spyOn(provider.stack, "pop").mockResolvedValue(undefined)

		// Create history item with different taskId
		const historyItem: HistoryItem = {
			id: "task-2", // Different from mockTask1.taskId
			number: 2,
			task: "different task",
			ts: Date.now(),
			tokensIn: 150,
			tokensOut: 250,
			totalCost: 0.002,
			workspace: "/test/workspace",
		}

		// Act: Create task with different history item
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: pop should be called
		expect(popSpy).toHaveBeenCalled()
	})

	it("should handle empty stack gracefully during rehydration attempt", async () => {
		// Setup: Empty stack (default state after construction)

		// Spy on stack.pop
		const popSpy = vi.spyOn(provider.stack, "pop").mockResolvedValue(undefined)

		// Create history item
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		// Act: Should not error and should call pop
		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: pop should be called (no current task to rehydrate)
		expect(popSpy).toHaveBeenCalled()
	})

	it("should maintain task stack integrity during flicker-free replacement", async () => {
		// Setup: Stack with multiple tasks
		const mockParentTask = {
			taskId: "parent-task",
			instanceId: "parent-instance",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			off: vi.fn(),
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await provider.stack.push(mockParentTask as any)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await provider.stack.push(mockTask1 as any)

		// Act: Rehydrate the current (top) task
		const historyItem: HistoryItem = {
			id: "task-1",
			number: 1,
			task: "test task",
			ts: Date.now(),
			tokensIn: 100,
			tokensOut: 200,
			totalCost: 0.001,
			workspace: "/test/workspace",
		}

		await provider.createTaskWithHistoryItem(historyItem)

		// Assert: Stack should maintain parent task and replace current task
		expect(provider.stack.size).toBe(2)
		expect(provider.stack.getStack()[0]).toBe(mockParentTask)
		expect(provider.stack.current).toBe(mockTask2)
	})
})
