// npx vitest run __tests__/removeClineFromStack-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"

import { TaskStackManager } from "../core/webview/TaskStackManager"
import type { Task } from "../core/task/Task"

describe("TaskStackManager.pop() delegation awareness", () => {
	function createMockHost(opts?: { getTaskWithId?: any; updateTaskHistory?: any }) {
		return {
			outputChannel: { appendLine: vi.fn() },
			emit: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			getTaskWithId: opts?.getTaskWithId ?? vi.fn(),
			updateTaskHistory: opts?.updateTaskHistory ?? vi.fn().mockResolvedValue([]),
			createTaskWithHistoryItem: vi.fn(),
			performPreparationTasks: vi.fn(),
		}
	}

	function createMockTask(overrides: Partial<Task> = {}): Task {
		return {
			taskId: "task-1",
			instanceId: "inst-1",
			parentTaskId: undefined,
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			off: vi.fn(),
			...overrides,
		} as unknown as Task
	}

	it("repairs parent metadata (delegated → active) when a delegated child is removed", async () => {
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const childTask = createMockTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
		})
		await manager.push(childTask)

		await manager.pop()

		// Stack should be empty after pop
		expect(manager.size).toBe(0)

		// Parent lookup should have been called
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")

		// Parent metadata should be repaired
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)
		const updatedParent = updateTaskHistory.mock.calls[0][0]
		expect(updatedParent).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				awaitingChildId: undefined,
			}),
		)

		// Log the repair
		expect(host.outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Repaired parent parent-1 metadata"),
		)
	})

	it("does NOT modify parent metadata when the task has no parentTaskId (non-delegated)", async () => {
		const getTaskWithId = vi.fn()
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const standaloneTask = createMockTask({
			taskId: "standalone-1",
			parentTaskId: undefined,
		})
		await manager.push(standaloneTask)

		await manager.pop()

		// Stack should be empty
		expect(manager.size).toBe(0)

		// No parent lookup or update should happen
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when awaitingChildId does not match the popped child", async () => {
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-OTHER", // different child
				delegatedToId: "child-OTHER",
				childIds: ["child-OTHER"],
			},
		})
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const childTask = createMockTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
		})
		await manager.push(childTask)

		await manager.pop()

		// Parent was looked up but should NOT be updated
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when parent status is not 'delegated'", async () => {
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "completed", // already completed
				awaitingChildId: "child-1",
				childIds: ["child-1"],
			},
		})
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const childTask = createMockTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
		})
		await manager.push(childTask)

		await manager.pop()

		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("catches and logs errors during parent metadata repair without blocking the pop", async () => {
		const getTaskWithId = vi.fn().mockRejectedValue(new Error("Storage unavailable"))
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const childTask = createMockTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
		})
		await manager.push(childTask)

		// Should NOT throw
		await manager.pop()

		// Stack should still be empty (pop was not blocked)
		expect(manager.size).toBe(0)

		// The abort should still have been called
		expect(childTask.abortTask).toHaveBeenCalledWith(true)

		// Error should be logged as non-fatal
		expect(host.outputChannel.appendLine).toHaveBeenCalledWith(
			expect.stringContaining("Failed to repair parent metadata for parent-1 (non-fatal)"),
		)

		// No update should have been attempted
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("handles empty stack gracefully", async () => {
		const getTaskWithId = vi.fn()
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		// Should not throw
		await manager.pop()

		expect(manager.size).toBe(0)
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("skips delegation repair when skipDelegationRepair option is true", async () => {
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const childTask = createMockTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
		})
		await manager.push(childTask)

		// Call with skipDelegationRepair: true (as delegateParentAndOpenChild would)
		await manager.pop({ skipDelegationRepair: true })

		// Stack should be empty after pop
		expect(manager.size).toBe(0)

		// Parent lookup should NOT have been called — repair was skipped entirely
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT reset grandparent during A→B→C nested delegation transition", async () => {
		const grandparentHistory = {
			id: "task-A",
			task: "Grandparent task",
			ts: 1000,
			number: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "task-B",
			delegatedToId: "task-B",
			childIds: ["task-B"],
		}

		const getTaskWithId = vi.fn(async function (id: string) {
			if (id === "task-A") {
				return { historyItem: { ...grandparentHistory } }
			}
			throw new Error("Task not found")
		})
		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const host = createMockHost({ getTaskWithId, updateTaskHistory })
		const manager = new TaskStackManager(host)

		const taskB = createMockTask({
			taskId: "task-B",
			parentTaskId: "task-A",
		})
		await manager.push(taskB)

		// Simulate what delegateParentAndOpenChild does: pop B with skipDelegationRepair
		await manager.pop({ skipDelegationRepair: true })

		// B was popped
		expect(manager.size).toBe(0)

		// Grandparent A should NOT have been looked up or modified
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()

		// Grandparent A's metadata remains intact (delegated, awaitingChildId: task-B)
		// The caller (delegateParentAndOpenChild) will update A to point to C separately.
	})
})
