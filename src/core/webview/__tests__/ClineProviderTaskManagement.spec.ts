import { describe, it, expect, vi, beforeEach } from "vitest"

import { ClineProviderTaskManagement } from "../ClineProviderTaskManagement"
import type { TaskStackManager } from "../TaskStackManager"
import type { PendingEditManager } from "../PendingEditManager"
import type { Task } from "../../task/Task"

vi.mock("../../task/Task", () => {
	const MockTask = vi.fn(function (this: any) {
		this.taskId = "mock-task"
		this.instanceId = "mock-inst"
		this.start = vi.fn()
	}) as any
	return { Task: MockTask }
})

describe("ClineProviderTaskManagement", () => {
	let taskManagement: ClineProviderTaskManagement
	let mockStack: TaskStackManager
	let mockTaskHistory: { getRecentTasks: () => string[] }
	let mockPendingEditManager: PendingEditManager
	let mockCustomModesManager: { updateCustomMode: (slug: string, mode: any) => Promise<void> }
	let mockProvider: any
	let mockHost: any

	beforeEach(() => {
		mockStack = {
			current: undefined,
			size: 0,
			taskIds: [],
			root: undefined,
			push: vi.fn().mockResolvedValue(undefined),
			pop: vi.fn().mockResolvedValue(undefined),
			rehydrate: vi.fn().mockResolvedValue(undefined),
		} as unknown as TaskStackManager

		mockTaskHistory = {
			getRecentTasks: vi.fn().mockReturnValue(["task1", "task2"]),
		}

		mockPendingEditManager = {
			get: vi.fn().mockReturnValue(undefined),
			clear: vi.fn(),
		} as unknown as PendingEditManager

		mockCustomModesManager = {
			updateCustomMode: vi.fn().mockResolvedValue(undefined),
		}

		mockProvider = {
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			log: vi.fn(),
			updateGlobalState: vi.fn().mockResolvedValue(undefined),
			context: { workspaceState: { get: vi.fn().mockReturnValue(false) } },
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(undefined),
				listConfig: vi.fn().mockResolvedValue([]),
			},
			settingsManager: { setGlobalValue: vi.fn().mockResolvedValue(undefined) },
			activateProviderProfile: vi.fn().mockResolvedValue(undefined),
		}

		mockHost = {
			stack: mockStack,
			taskHistory: mockTaskHistory,
			pendingEditManager: mockPendingEditManager,
			customModesManager: mockCustomModesManager,
			taskCreationCallback: vi.fn(),
			provider: mockProvider,
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: {},
				organizationAllowList: { allowAll: true },
				enableCheckpoints: true,
				checkpointTimeout: 30,
				experiments: {},
			}),
			setValues: vi.fn().mockResolvedValue(undefined),
			setProviderProfile: vi.fn().mockResolvedValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: {} }),
			log: vi.fn(),
		}

		taskManagement = new ClineProviderTaskManagement(mockHost)
	})

	describe("getCurrentTask", () => {
		it("returns undefined when stack is empty", () => {
			expect(taskManagement.getCurrentTask()).toBeUndefined()
		})

		it("returns current task from stack", () => {
			const mockTask = { taskId: "test-task" } as Task
			mockStack.current = mockTask
			expect(taskManagement.getCurrentTask()).toBe(mockTask)
		})
	})

	describe("getTaskStackSize", () => {
		it("returns stack size", () => {
			mockStack.size = 3
			expect(taskManagement.getTaskStackSize()).toBe(3)
		})
	})

	describe("getCurrentTaskStack", () => {
		it("returns task IDs from stack", () => {
			mockStack.taskIds = ["task1", "task2", "task3"]
			expect(taskManagement.getCurrentTaskStack()).toEqual(["task1", "task2", "task3"])
		})
	})

	describe("getRecentTasks", () => {
		it("returns recent tasks from history", () => {
			expect(taskManagement.getRecentTasks()).toEqual(["task1", "task2"])
		})
	})

	describe("clearTaskInternal", () => {
		it("does nothing when stack is empty", async () => {
			mockStack.size = 0
			await taskManagement.clearTaskInternal()
			expect(mockStack.pop).not.toHaveBeenCalled()
		})

		it("pops task from stack when not empty", async () => {
			mockStack.size = 1
			mockStack.current = { taskId: "test-task", instanceId: "abc" } as Task
			await taskManagement.clearTaskInternal()
			expect(mockStack.pop).toHaveBeenCalled()
		})
	})

	describe("cancelTaskInternal", () => {
		it("does nothing when no current task", async () => {
			mockStack.current = undefined
			await taskManagement.cancelTaskInternal()
			expect(mockHost.getTaskWithId).not.toHaveBeenCalled()
		})

		it("cancels current task and rehydrates from history", async () => {
			const mockTask = {
				taskId: "test-task",
				instanceId: "abc",
				rootTask: undefined,
				parentTask: undefined,
				abortReason: undefined,
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(),
				abandoned: false,
				isStreaming: false,
				didFinishAbortingStream: true,
				isWaitingForFirstChunk: false,
			} as unknown as Task

			mockStack.current = mockTask
			mockStack.size = 1

			const historyItem = { id: "test-task", mode: "code" }
			mockHost.getTaskWithId.mockResolvedValue({ historyItem })

			vi.spyOn(taskManagement, "createTaskWithHistoryItem").mockResolvedValue(mockTask)

			await taskManagement.cancelTaskInternal()

			expect(mockTask.cancelCurrentRequest).toHaveBeenCalled()
			expect(mockTask.abortTask).toHaveBeenCalled()
			expect(mockTask.abandoned).toBe(true)
			expect(mockTask.abortReason).toBe("user_cancelled")
		})
	})

	describe("createTaskWithHistoryItem", () => {
		it("creates task from history item", async () => {
			const historyItem = { id: "test-task", mode: "code" }
			const mockTask = { taskId: "test-task", instanceId: "abc" } as Task

			vi.spyOn(taskManagement as any, "createTaskInstanceFromHistory").mockResolvedValue(mockTask)

			await taskManagement.createTaskWithHistoryItem(historyItem as any)

			expect(mockStack.push).toHaveBeenCalledWith(mockTask)
		})

		it("rehydrates task when it is the current task", async () => {
			const historyItem = { id: "test-task", mode: "code" }
			const mockTask = { taskId: "test-task", instanceId: "abc" } as Task

			mockStack.current = mockTask

			vi.spyOn(taskManagement as any, "createTaskInstanceFromHistory").mockResolvedValue(mockTask)

			await taskManagement.createTaskWithHistoryItem(historyItem as any)

			expect(mockStack.rehydrate).toHaveBeenCalledWith(mockTask)
			expect(mockStack.push).not.toHaveBeenCalled()
		})
	})

	describe("createTaskInternal", () => {
		it("calls setValues with configuration", async () => {
			const config = { currentApiConfigName: "test-profile" } as any
			await taskManagement.createTaskInternal("hello", [], undefined, {}, config)
			expect(mockHost.setValues).toHaveBeenCalledWith(config)
			expect(mockHost.setProviderProfile).toHaveBeenCalledWith("test-profile")
		})

		it("pops stack for top-level tasks", async () => {
			await taskManagement.createTaskInternal("hello")
			expect(mockStack.pop).toHaveBeenCalled()
		})

		it("does not pop stack for child tasks", async () => {
			await taskManagement.createTaskInternal("hello", [], { taskId: "parent" } as any)
			expect(mockStack.pop).not.toHaveBeenCalled()
		})

		it("throws OrganizationAllowListViolationError when profile not allowed", async () => {
			mockHost.getState.mockResolvedValue({
				apiConfiguration: { apiProvider: "blocked" },
				organizationAllowList: { allowAll: false, providers: {} },
				enableCheckpoints: true,
				checkpointTimeout: 30,
				experiments: {},
			})
			await expect(taskManagement.createTaskInternal("hello")).rejects.toThrow("violated_organization_allowlist")
		})

		it("creates task and pushes to stack", async () => {
			await taskManagement.createTaskInternal("hello", ["img.png"])
			expect(mockStack.push).toHaveBeenCalledTimes(1)
			const pushedTask = (mockStack.push as any).mock.calls[0][0]
			expect(pushedTask.taskId).toBe("mock-task")
		})
	})
})
