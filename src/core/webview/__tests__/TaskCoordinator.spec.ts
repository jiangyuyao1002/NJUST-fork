import { beforeEach, describe, expect, it, vi } from "vitest"

import { TaskCoordinator, type ITaskCoordinatorHost } from "../TaskCoordinator"

describe("TaskCoordinator", () => {
	let host: ITaskCoordinatorHost
	let coordinator: TaskCoordinator
	const task = { taskId: "task-1" } as any

	beforeEach(() => {
		host = {
			getCurrentTask: vi.fn(() => task),
			getTaskStackSize: vi.fn(() => 1),
			getCurrentTaskStack: vi.fn(() => ["task-1"]),
			getRecentTasks: vi.fn(() => ["task-1"]),
			createTask: vi.fn().mockResolvedValue(task),
			cancelTask: vi.fn().mockResolvedValue(undefined),
			clearTask: vi.fn().mockResolvedValue(undefined),
			resumeTask: vi.fn(),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(task),
		}
		coordinator = new TaskCoordinator(host)
	})

	it("delegates task stack reads", () => {
		expect(coordinator.getCurrentTask()).toBe(task)
		expect(coordinator.getTaskStackSize()).toBe(1)
		expect(coordinator.getCurrentTaskStack()).toEqual(["task-1"])
		expect(coordinator.getRecentTasks()).toEqual(["task-1"])
	})

	it("delegates task lifecycle operations", async () => {
		await expect(
			coordinator.createTask("hello", ["img"], undefined, { taskId: "task-1" } as any, {}),
		).resolves.toBe(task)
		await coordinator.cancelTask()
		await coordinator.clearTask()
		coordinator.resumeTask("task-1")

		expect(host.createTask).toHaveBeenCalledWith("hello", ["img"], undefined, { taskId: "task-1" }, {})
		expect(host.cancelTask).toHaveBeenCalledOnce()
		expect(host.clearTask).toHaveBeenCalledOnce()
		expect(host.resumeTask).toHaveBeenCalledWith("task-1")
	})

	it("delegates task creation from history", async () => {
		const historyItem = { id: "task-1" } as any

		await expect(coordinator.createTaskWithHistoryItem(historyItem, { startTask: true })).resolves.toBe(task)

		expect(host.createTaskWithHistoryItem).toHaveBeenCalledWith(historyItem, { startTask: true })
	})
})
